"""AI review of analysis key frames using the Claude API.

Sends the extracted key frames (base64 JPEG) plus the measured metrics to a
vision model and returns a structured review: what actually happens in each
frame, whether the pipeline's phase labels are right, whether the clip ends in
a crash, and a coaching summary written from visual understanding rather than
angle heuristics alone.
"""

from __future__ import annotations

import json
import os

AI_MODEL = os.getenv("RIDERLENS_AI_MODEL", "claude-opus-4-8")


class AIReviewError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


SYSTEM_PROMPT = """You are an expert mountain-bike skills coach reviewing key frames from one riding clip for the RiderLens app. The frames are in chronological order. Each comes with a phase label assigned by a computer-vision pipeline and approximate body-angle measurements from MediaPipe pose detection.

Rules:
- Trust your eyes over the labels and the numbers. The pipeline currently picks frames at fixed time offsets, so its phase labels are often wrong. Pose measurements on motion-blurred or post-crash frames are unreliable; pose confidence below ~80% usually means the "rider" the pipeline saw is not really there.
- If the rider and bike separate, or the bike is tumbling or lying on the ground without the rider, that is a crash. Say so plainly, and do not produce body-technique coaching from post-crash frames.
- Coaching language: constructive, specific, coach-like. Reference what is visible in the frames. No medical claims, no safety guarantees — feedback is educational.
- Be honest about uncertainty and about what cannot be judged from these few frames."""

REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["frames", "crash_detected", "event_summary", "coaching"],
    "properties": {
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["phase_label", "time_seconds", "rider_state", "what_is_happening", "phase_label_correct"],
                "properties": {
                    "phase_label": {"type": "string", "description": "The pipeline's label for this frame, echoed back."},
                    "time_seconds": {"type": "number"},
                    "rider_state": {
                        "type": "string",
                        "enum": ["riding", "airborne", "landing", "crashed", "bike_only", "not_visible"],
                    },
                    "what_is_happening": {"type": "string", "description": "One or two sentences describing what is visibly happening."},
                    "phase_label_correct": {"type": "boolean", "description": "Whether the pipeline's phase label matches what the frame actually shows."},
                },
            },
        },
        "crash_detected": {"type": "boolean"},
        "event_summary": {
            "type": "string",
            "description": "Two or three sentences telling the story of the whole clip based on the frames.",
        },
        "coaching": {
            "type": "object",
            "additionalProperties": False,
            "required": ["summary", "positives", "improvements"],
            "properties": {
                "summary": {"type": "string"},
                "positives": {"type": "array", "items": {"type": "string"}},
                "improvements": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
}


def _call_structured(system_prompt: str, content: list[dict], schema: dict) -> dict:
    """Send one vision request to the Claude API and return the parsed structured output."""
    try:
        import anthropic
    except ImportError:
        raise AIReviewError("The anthropic package is not installed. Run: pip install -r requirements.txt", status_code=503)

    try:
        client = anthropic.Anthropic()
    except Exception as error:
        raise AIReviewError(
            f"Anthropic client could not be created ({error}). Set ANTHROPIC_API_KEY in the worker environment.",
            status_code=503,
        )

    try:
        response = client.messages.create(
            model=AI_MODEL,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            system=system_prompt,
            messages=[{"role": "user", "content": content}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
    except TypeError:
        # The SDK resolves credentials at request time; no key/profile raises TypeError here.
        raise AIReviewError(
            "No Anthropic API credentials found. Start the worker with ANTHROPIC_API_KEY set to enable AI features.",
            status_code=503,
        )
    except anthropic.AuthenticationError:
        raise AIReviewError(
            "Anthropic API authentication failed. Set a valid ANTHROPIC_API_KEY in the worker environment.",
            status_code=503,
        )
    except anthropic.APIConnectionError:
        raise AIReviewError("Could not reach the Anthropic API. Check the network connection.", status_code=502)
    except anthropic.APIStatusError as error:
        raise AIReviewError(f"Anthropic API error {error.status_code}: {error.message}", status_code=502)

    if response.stop_reason == "refusal":
        raise AIReviewError("The model declined to analyze this clip.", status_code=502)

    text = "".join(block.text for block in response.content if block.type == "text")
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        raise AIReviewError("The model returned output that could not be parsed as JSON.", status_code=502)

    result["model"] = response.model
    return result


def review_key_frames(metrics: list) -> dict:
    frames = [metric for metric in metrics if metric.frameImage]
    if not frames:
        raise AIReviewError(
            "This analysis has no frame images. Run it from the Analysis Lab (frames are included there) and try again.",
            status_code=422,
        )

    content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"Review these {len(frames)} key frames from one mountain-bike clip (side view). "
                "For each frame: describe what is visibly happening, judge the rider state, and say whether "
                "the pipeline's phase label is correct. Then judge whether the clip ends in a crash, summarize "
                "the event, and write the coaching review."
            ),
        }
    ]
    for index, metric in enumerate(frames):
        content.append(
            {
                "type": "text",
                "text": (
                    f"Frame {index + 1}: pipeline label '{metric.phase}' at {metric.frameTime:.2f}s. "
                    f"Approximate measurements: torso {metric.torsoAngle:.0f}deg, hip {metric.hipAngle:.0f}deg, "
                    f"knee {metric.kneeAngle:.0f}deg, elbow {metric.elbowAngle:.0f}deg, bike pitch {metric.bikePitchAngle:.0f}deg. "
                    f"Geometry source: {metric.geometrySource}. Pose confidence: {metric.confidence * 100:.0f}%."
                ),
            }
        )
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": metric.frameImage.split(",", 1)[1],
                },
            }
        )

    return _call_structured(SYSTEM_PROMPT, content, REVIEW_SCHEMA)


KEYFRAME_SYSTEM = """You are an expert mountain-bike coach scanning a contact sheet: frames sampled uniformly from one riding clip (side view), in chronological order, each labeled with its timestamp. Your job is to find the timestamps of the key moments of the jump attempt.

Rules:
- Choose time_seconds values ONLY from the timestamps printed with the frames.
- Include an event only when a frame actually shows it: approach (riding toward the feature), compression (lowest body position pressing into the lip), takeoff (wheels leaving the lip), peak_air (most airborne frame), landing (touchdown), crash (rider and bike separating or down).
- If the clip ends in a crash: include the real events that happened before it, then one crash event at the first clearly-crashed frame. Do not invent takeoff, peak_air, or landing that never happened.
- Pick the single best frame per event. It is fine to return only two or three events if that is all the clip shows."""

KEYFRAME_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["event_type", "summary", "events"],
    "properties": {
        "event_type": {"type": "string", "enum": ["clean_jump", "crash", "no_jump_visible", "other"]},
        "summary": {"type": "string", "description": "Two or three sentences telling the story of the clip."},
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "time_seconds", "why"],
                "properties": {
                    "name": {
                        "type": "string",
                        "enum": ["approach", "compression", "takeoff", "peak_air", "landing", "crash"],
                    },
                    "time_seconds": {"type": "number"},
                    "why": {"type": "string", "description": "One sentence: what this frame shows."},
                },
            },
        },
    },
}


def find_key_frames_ai(sampled_frames: list[tuple[float, str]]) -> dict:
    """sampled_frames: (time_seconds, jpeg data URL) pairs, chronological. Returns the structured event list."""
    content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"Contact sheet: {len(sampled_frames)} frames sampled uniformly from one clip, in order. "
                "Identify the key moments per the instructions."
            ),
        }
    ]
    for time_seconds, data_url in sampled_frames:
        content.append({"type": "text", "text": f"t={time_seconds:.2f}s"})
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": data_url.split(",", 1)[1]},
            }
        )
    return _call_structured(KEYFRAME_SYSTEM, content, KEYFRAME_SCHEMA)

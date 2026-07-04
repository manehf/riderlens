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
from pathlib import Path

AI_MODEL = os.getenv("RIDERLENS_AI_MODEL", "claude-opus-4-8")
# Window-finding needs capture precision, not coaching precision — a cheaper model may
# suffice (claude-haiku-4-5 matched the Opus window on the first test clip). Default stays
# AI_MODEL until more ground-truth clips validate the switch.
WINDOW_MODEL = os.getenv("RIDERLENS_WINDOW_MODEL", AI_MODEL)

# Distilled from the how_to_jump/ transcripts by worker/scripts/distill_knowledge.py.
KNOWLEDGE_PATH = Path(__file__).resolve().parent / "knowledge" / "regular_jump.md"


def _with_knowledge(system_prompt: str) -> str:
    """Append the distilled coaching knowledge base to a system prompt when available."""
    if not KNOWLEDGE_PATH.exists():
        return system_prompt
    knowledge = KNOWLEDGE_PATH.read_text(encoding="utf-8")
    return (
        system_prompt
        + "\n\nUse this coaching knowledge base (distilled from expert MTB coaching videos) as your reference for"
        " correct technique per phase, named mistakes and their visual signatures, which moments are most"
        " diagnostic, and how to phrase coaching:\n\n<coaching_knowledge>\n"
        + knowledge
        + "\n</coaching_knowledge>"
    )


class AIReviewError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


SYSTEM_PROMPT = """You are an expert mountain-bike skills coach reviewing key frames from one riding clip for the RiderLens app. The frames are in chronological order. Each comes with a phase label assigned by a computer-vision pipeline and approximate body-angle measurements from MediaPipe pose detection.

Rules:
- Trust your eyes over the labels and the numbers. The pipeline currently picks frames at fixed time offsets, so its phase labels are often wrong. Pose measurements on motion-blurred or post-crash frames are unreliable; pose confidence below ~80% usually means the "rider" the pipeline saw is not really there.
- If the rider and bike separate, or the bike is tumbling or lying on the ground without the rider, that is a crash. Say so plainly, and do not produce body-technique coaching from post-crash frames.
- Coaching language: constructive, specific, coach-like. Reference what is visible in the frames. No medical claims, no safety guarantees — feedback is educational.
- When a frame or sequence shows a named mistake from the coaching knowledge base, call it by name in identified_mistakes and coach the fix using the coaching voice. Only name mistakes you can actually see.
- You may also receive a dense per-frame measurement series across the jump window (knee angle, torso angle, hip height, bike pitch when wheels were confirmed, pose confidence) and additional small in-air frames. Use the series for timing-based judgments — compression depth, extension speed through the lip, pitch progression in the air, absorption after touchdown — and quote concrete times/values when they support a coaching point. Treat low-confidence rows as unreliable.
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
            "required": ["summary", "positives", "improvements", "identified_mistakes"],
            "properties": {
                "summary": {"type": "string"},
                "positives": {"type": "array", "items": {"type": "string"}},
                "improvements": {"type": "array", "items": {"type": "string"}},
                "identified_mistakes": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Named mistakes from the coaching knowledge base visible in these frames; empty if none.",
                },
            },
        },
    },
}


def _call_structured(system_prompt: str, content: list[dict], schema: dict, model: str | None = None) -> dict:
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

    request = dict(
        model=model or AI_MODEL,
        max_tokens=16000,
        system=system_prompt,
        messages=[{"role": "user", "content": content}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    try:
        try:
            response = client.messages.create(thinking={"type": "adaptive"}, **request)
        except anthropic.BadRequestError as error:
            # Smaller models (e.g. Haiku) reject adaptive thinking; retry without it.
            if "adaptive thinking is not supported" not in str(error):
                raise
            response = client.messages.create(**request)
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


def review_key_frames(metrics: list, series: list[dict] | None = None, air_frames: list[dict] | None = None) -> dict:
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

    if series:
        rows = series
        if len(rows) > 40:
            keep = max(1, len(rows) // 40)
            rows = rows[::keep]

        def fmt(value, suffix=""):
            return f"{value}{suffix}" if value is not None else "-"

        table = "\n".join(
            f"t={row['t']:.2f}s knee={fmt(row['kneeAngle'])} torso={fmt(row['torsoAngle'])} "
            f"hipH={fmt(row['hipHeight'])} pitch={fmt(row['pitch'])} conf={row['confidence']:.2f}"
            for row in rows
        )
        content.append(
            {
                "type": "text",
                "text": (
                    "Dense per-frame measurements across the jump window (pose-based, approximate; "
                    "hipH is normalized hip height where higher = further up the frame):\n" + table
                ),
            }
        )

    for extra in air_frames or []:
        if not extra.get("image"):
            continue
        content.append({"type": "text", "text": f"Additional in-air frame at t={extra['t']:.2f}s:"})
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": extra["image"].split(",", 1)[1]},
            }
        )

    return _call_structured(_with_knowledge(SYSTEM_PROMPT), content, REVIEW_SCHEMA)


KEYFRAME_SYSTEM = """You are an expert mountain-bike coach scanning a contact sheet: frames sampled uniformly from one riding clip (side view), in chronological order, each labeled with its timestamp. Your job is to find the timestamps of the key moments of the jump attempt.

Rules:
- Choose time_seconds values ONLY from the timestamps printed with the frames.
- Include an event only when a frame actually shows it: approach (riding toward the feature), compression (lowest body position pressing into the lip), takeoff (wheels leaving the lip), peak_air (most airborne frame), landing (touchdown), crash (rider and bike separating or down).
- If the clip ends in a crash: include the real events that happened before it, then one crash event at the first clearly-crashed frame. Do not invent takeoff, peak_air, or landing that never happened.
- Prefer the most diagnostic frames per the knowledge base's frame-selection guidance: deepest compression at the base of the lip, front wheel leaving the lip, peak of the arc, just before touchdown.
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
    return _call_structured(_with_knowledge(KEYFRAME_SYSTEM), content, KEYFRAME_SCHEMA, model=WINDOW_MODEL)

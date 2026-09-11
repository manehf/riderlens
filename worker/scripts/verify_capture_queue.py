"""Exercise the legacy and queued contracts with a repository video fixture.

Explicit --url required. Uploads private test media and runs three 0.3s analyses;
never prints credentials or returned media. Uses the app's existing client key.
"""

import argparse
import json
from pathlib import Path
import time
import uuid

import httpx


def validate(payload):
    assert set(payload) == {"clip", "skeletonClip", "window", "series", "filmstrip", "events", "flight"}
    assert payload["clip"].startswith("data:video/mp4;base64,")
    assert payload["skeletonClip"].startswith("data:video/mp4;base64,")
    assert len(payload["filmstrip"]) == len(payload["series"]) > 0
    assert payload["window"] == {"start": 4.4, "end": 4.7}
    print(json.dumps({"frames": len(payload["series"]), "media_valid": True}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    key = json.loads((root / "eas.json").read_text())["build"]["production"]["env"]["EXPO_PUBLIC_ANALYSIS_WORKER_KEY"]
    clip = root / "clips/regular_jump/fail/jump_fail.mp4"
    with httpx.Client(base_url=args.url.rstrip("/"), headers={"x-riderlens-key": key}, timeout=300) as client:
        health = client.get("/health")
        health.raise_for_status()
        assert health.json()["captureJobsEnabled"] is True
        assert not health.json()["captureBusy"], "Wait for existing analyses before running smoke verification"
        started = time.monotonic()
        with clip.open("rb") as source:
            response = client.post("/capture/record", data={"start_seconds": "4.4", "end_seconds": "4.7"},
                                   files={"video": ("fixture.mp4", source, "video/mp4")})
        response.raise_for_status()
        assert response.status_code == 200
        validate(response.json())
        print(json.dumps({"legacy_status": response.status_code, "seconds": round(time.monotonic() - started, 2)}), flush=True)
        ids = [f"analysis-smoke-{uuid.uuid4().hex}" for _ in range(2)]
        for request_id in ids:
            started = time.monotonic()
            with clip.open("rb") as source:
                response = client.post("/capture/jobs", data={"request_id": request_id, "start_seconds": "4.4", "end_seconds": "4.7"},
                                       files={"video": ("fixture.mp4", source, "video/mp4")})
            response.raise_for_status()
            assert response.status_code == 202
            assert response.json()["jobId"] == request_id
            print(json.dumps({"submission_status": response.status_code, "job_status": response.json()["status"],
                              "seconds": round(time.monotonic() - started, 2)}), flush=True)
        deadline = time.monotonic() + 300
        pending = set(ids)
        while pending and time.monotonic() < deadline:
            for request_id in list(pending):
                response = client.get(f"/capture/jobs/{request_id}")
                response.raise_for_status()
                status = response.json()["status"]
                if status == "failed":
                    raise RuntimeError(f"Queued smoke analysis failed: {response.json()['error']}")
                if status == "ready":
                    result = client.get(f"/capture/result/{request_id}")
                    result.raise_for_status()
                    validate(result.json())
                    pending.remove(request_id)
                    print(json.dumps({"queued_result": "ready", "remaining": len(pending)}), flush=True)
            if pending:
                time.sleep(2)
        assert not pending, "Queued results did not finish before the verification deadline"
        assert client.get("/capture/jobs/analysis-missing-smoke").status_code == 404
        assert httpx.get(args.url.rstrip("/") + f"/capture/jobs/{ids[0]}").status_code == 401
        print("PASS: legacy final payload, two queued analyses, result recovery, and authentication", flush=True)


if __name__ == "__main__":
    main()

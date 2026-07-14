# RiderLens analysis worker: FastAPI + MediaPipe + OpenCV + FFmpeg.
# Built for linux/amd64 (MediaPipe ships manylinux x86_64 wheels; Fly's
# remote builders target amd64 by default).
FROM python:3.12-slim

# ffmpeg: clip cropping + skeleton share render.
# libgl1 / libglib2.0-0: native deps of the MediaPipe/OpenCV wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Heavy pose model baked in: MediaPipe otherwise downloads it on first use,
# which would ride on every cold start of a scale-to-zero machine.
RUN python -c "import mediapipe, os, urllib.request; d = os.path.join(os.path.dirname(mediapipe.__file__), 'modules/pose_landmark'); urllib.request.urlretrieve('https://storage.googleapis.com/mediapipe-assets/pose_landmark_heavy.tflite', os.path.join(d, 'pose_landmark_heavy.tflite'))"

# App code, the bike-detector model (baked in — avoids a cold-start download),
# and the coaching knowledge base.
COPY app ./app
COPY models ./models

ENV PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

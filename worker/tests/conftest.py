import os

# Tests exercise pipeline logic, not the pose model zoo: pin the legacy
# engine so runs stay fast and never depend on the RTMPose weights cache.
os.environ.setdefault("POSE_ENGINE", "mediapipe")

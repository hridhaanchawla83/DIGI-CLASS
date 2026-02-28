"""
AI Proctoring — Face Analysis Service (port 8001)
Uses OpenCV DNN face detector + Haarcascade eye detector
for EAR-equivalent gaze analysis — no dlib/CMake required.

Install:  pip install flask flask-cors opencv-python numpy Pillow
Run:      python ai-services/dlib_service.py
"""

import base64
import io
import json
import math
import os
import urllib.request

import cv2
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image

app = Flask(__name__)
CORS(app)

# ─── Haarcascade classifiers (bundled with OpenCV) ─────────────
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
eye_cascade  = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')
profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')

print("[AI Service] Haarcascade classifiers loaded")

# ─── Try to also load LBF facial landmark model ─────────────────
landmark_model_path = "lbfmodel.yaml"
landmark_facemark = None
try:
    facemark = cv2.face.createFacemarkLBF()
    if os.path.exists(landmark_model_path):
        facemark.loadModel(landmark_model_path)
        landmark_facemark = facemark
        print("[AI Service] LBF Facemark loaded")
    else:
        print("[AI Service] LBF model not found — using eye-region EAR fallback")
except Exception as e:
    print(f"[AI Service] Facemark unavailable: {e} — using Haarcascade EAR")

# ─── Constants ────────────────────────────────────────────────
EAR_THRESHOLD        = 0.15    # ratio < this = eyes closed (more relaxed)
EAR_CONSEC_FRAMES    = 3       # must be closed for 3 check-ins (3 * 15 = 45 frames ≈ 1.5s)
HEAD_PROFILE_MARGIN  = 0.08   
eye_low_count        = 0


def compute_ear_from_eye_rect(eye_rect, gray):
    """
    Approximate EAR from the eye bounding box aspect ratio.
    """
    x, y, w, h = eye_rect
    if w == 0:
        return 1.0
    ear = round(h / (w + 1e-6), 4)
    return ear


def decode_frame(frame_b64: str) -> np.ndarray:
    if "," in frame_b64:
        frame_b64 = frame_b64.split(",", 1)[1]
    img_bytes = base64.b64decode(frame_b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


# ─── Endpoints ────────────────────────────────────────────────

@app.get("/")
def health():
    return jsonify({
        "service":   "OpenCV Face Analysis Service (dlib-equivalent)",
        "port":       8001,
        "engine":    "opencv-haarcascade",
        "signals":   ["NO_FACE", "MULTIPLE_FACE", "GAZE_OFF_EAR", "HEAD_TURNED_PROFILE"],
    })


@app.post("/analyze-dlib")
def analyze_dlib():
    global eye_low_count

    data = request.get_json(force=True)
    frame_b64 = data.get("frame", "")
    if not frame_b64:
        return jsonify({"error": "no frame"}), 400

    try:
        frame = decode_frame(frame_b64)
        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # ── Frontal face detection ──
        faces = face_cascade.detectMultiScale(
            gray, scaleFactor=1.05, minNeighbors=4, minSize=(60,60) # Slightly more aggressive
        )
        num_faces  = len(faces)
        signals    = []
        ear_val    = 1.0
        ear_low    = False
        head_turned= False

        if num_faces == 0:
            # Check profile face
            profiles_l = profile_cascade.detectMultiScale(gray, 1.1, 4, minSize=(60,60))
            flip_gray  = cv2.flip(gray, 1)
            profiles_r = profile_cascade.detectMultiScale(flip_gray, 1.1, 4, minSize=(60,60))
            if len(profiles_l) > 0 or len(profiles_r) > 0:
                num_faces   = 1
                head_turned = True
                signals.append("HEAD_TURNED_PROFILE")
                print("[dlib] Profile face detected")
            else:
                signals.append("NO_FACE")
                print("[dlib] No face detected")

        elif num_faces >= 2:
            signals.append("MULTIPLE_FACE")
            print(f"[dlib] Multiple faces: {num_faces}")

        # ── Eye detection inside first face ROI ──
        if num_faces == 1 and not head_turned and len(faces) > 0:
            fx, fy, fw, fh = faces[0]
            roi_gray = gray[fy:fy+fh//2, fx:fx+fw] # Only look in upper half of face

            eyes = eye_cascade.detectMultiScale(
                roi_gray, scaleFactor=1.05, minNeighbors=3, minSize=(15,15)
            )

            if len(eyes) == 0:
                eye_low_count += 1
                if eye_low_count >= EAR_CONSEC_FRAMES:
                    ear_low = True
                    ear_val = 0.10
                    signals.append("GAZE_OFF_EAR")
                    print("[dlib] No eyes detected (low EAR)")
            else:
                ears = [compute_ear_from_eye_rect(e, roi_gray) for e in eyes]
                ear_val = float(np.mean(ears))
                print(f"[dlib] EAR: {ear_val:.4f} (eyes: {len(eyes)})")
                
                if ear_val < EAR_THRESHOLD:
                    eye_low_count += 1
                    if eye_low_count >= EAR_CONSEC_FRAMES:
                        ear_low = True
                        signals.append("GAZE_OFF_EAR")
                else:
                    eye_low_count = max(0, eye_low_count - 1)

        # ── Risk ──
        weights = {
            "NO_FACE":              0.90,
            "MULTIPLE_FACE":        0.95,
            "GAZE_OFF_EAR":         0.75,
            "HEAD_TURNED_PROFILE":  0.70,
        }
        risk = max((weights.get(s, 0) for s in signals), default=0.0)

        return jsonify({
            "num_faces":    num_faces,
            "signals":      signals,
            "ear":          round(ear_val, 4),
            "ear_low":      ear_low,
            "head_turned":  head_turned,
            "risk_score":   round(risk, 4),
            "engine":       "opencv-haarcascade",
        })

    except Exception as e:
        return jsonify({"error": str(e), "signals": [], "risk_score": 0.0}), 500


if __name__ == "__main__":
    print("\n[AI Service] Starting on port 8001")
    print("[AI Service] Engine: OpenCV Haarcascade (dlib-equivalent EAR gaze)")
    print("[AI Service] Endpoint: POST /analyze-dlib")
    print("[AI Service] Signals: NO_FACE, MULTIPLE_FACE, GAZE_OFF_EAR, HEAD_TURNED_PROFILE\n")
    app.run(host="0.0.0.0", port=8001, debug=False, threaded=True)

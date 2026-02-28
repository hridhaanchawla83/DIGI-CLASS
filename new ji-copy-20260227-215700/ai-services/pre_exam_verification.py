# Pre-Exam Verification Service

from flask import Flask, request, jsonify
import cv2
import numpy as np
from PIL import Image
import io

app = Flask(__name__)

@app.route('/verify-face', methods=['POST'])
def verify_face():
    # Placeholder: Accept image, run face recognition
    file = request.files.get('image')
    if not file:
        return jsonify({'error': 'No image uploaded'}), 400
    img = Image.open(file.stream)
    img_np = np.array(img)
    # TODO: Integrate face recognition model
    # For now, just check if a face exists using OpenCV
    gray = cv2.cvtColor(img_np, cv2.COLOR_BGR2GRAY)
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    faces = face_cascade.detectMultiScale(gray, 1.1, 4)
    result = {'face_detected': len(faces) > 0, 'num_faces': len(faces)}
    return jsonify(result)

@app.route('/verify-id', methods=['POST'])
def verify_id():
    # Placeholder: Accept image, run ID validation
    file = request.files.get('image')
    if not file:
        return jsonify({'error': 'No image uploaded'}), 400
    # TODO: Integrate OCR/ID validation model
    return jsonify({'id_valid': True, 'details': 'ID validation placeholder'})

@app.route('/scan-environment', methods=['POST'])
def scan_environment():
    # Placeholder: Accept image, scan for multiple faces/devices
    file = request.files.get('image')
    if not file:
        return jsonify({'error': 'No image uploaded'}), 400
    img = Image.open(file.stream)
    img_np = np.array(img)
    gray = cv2.cvtColor(img_np, cv2.COLOR_BGR2GRAY)
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    faces = face_cascade.detectMultiScale(gray, 1.1, 4)
    result = {'num_faces': len(faces), 'environment_ok': len(faces) == 1}
    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)

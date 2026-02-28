# Pre-Exam Verification API Endpoints

This service exposes:
- `/verify-face` (POST): Upload candidate image, returns face detection result
- `/verify-id` (POST): Upload ID image, returns ID validation result
- `/scan-environment` (POST): Upload environment image, returns number of faces and environment status

## Usage
- Start service: `python pre_exam_verification.py`
- Send POST requests with image files to endpoints

## Next Steps
- Integrate advanced face recognition (e.g., FaceNet, DeepFace)
- Add OCR for ID validation (e.g., Tesseract, EasyOCR)
- Improve environment scan (detect devices, suspicious objects)

---

*Update this documentation as features are added.*

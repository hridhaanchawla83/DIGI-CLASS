# Live Monitoring API Endpoints

This service exposes:
- `/monitor-faces` (POST): Upload image, returns number of faces and multiple face detection
- `/monitor-eye` (POST): Upload image, returns eye movement detection
- `/monitor-audio` (POST): Upload audio file, returns audio anomaly detection (placeholder)
- `/monitor-tab` (POST): Send tab switch event, returns detection status

## Usage
- Start service: `python live_monitoring.py`
- Send POST requests with image/audio files or tab switch events to endpoints

## Next Steps
- Integrate advanced face/eye movement models
- Add real audio anomaly detection (speech, noise, unauthorized voices)
- Improve tab switch detection (frontend integration)

---

*Update this documentation as features are added.*

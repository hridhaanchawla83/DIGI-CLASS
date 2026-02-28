# Intelligent Flagging & Risk Scoring API

This service exposes:
- `/risk-score` (POST): Accepts anomaly data, returns AI-driven risk score, flag, and timestamped evidence

## Usage
- Start service: `python intelligent_flagging.py`
- Send POST requests with anomaly booleans to endpoint

## Risk Scoring
- Multiple faces: 0.4
- Eye movement: 0.2
- Audio anomaly: 0.2
- Tab switch: 0.2
- Score capped at 1.0
- Flags: high-risk (>=0.7), medium-risk (>=0.4), low-risk (<0.4)

## Next Steps
- Integrate advanced ML models for anomaly classification
- Tune weights based on real-world data
- Add false positive reduction logic

---

*Update this documentation as features are added.*

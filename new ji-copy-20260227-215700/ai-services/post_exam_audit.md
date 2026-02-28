# Post-Exam Audit & Report API

This service exposes:
- `/generate-report` (POST): Accepts candidate, exam, risk score, flag, and evidence; returns auto-generated proctoring report with timestamp

## Usage
- Start service: `python post_exam_audit.py`
- Send POST requests with exam session data to endpoint

## Next Steps
- Save reports to database
- Attach media evidence (images, audio snippets)
- Provide downloadable PDF/HTML report

---

*Update this documentation as features are added.*

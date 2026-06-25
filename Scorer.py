"""
InboxAI — Lightweight Scoring Engine
Zero external API calls for basic classification.
OpenAI used ONLY for premium deep-analysis.
"""

import re

# ── Signal Weights ─────────────────────────────────────────────────────────────
WEIGHTS = {
    "unsubscribe_footer":     20,
    "bulk_sender_pattern":    18,
    "marketing_language":     15,
    "promotional_subject":    15,
    "newsletter_pattern":     14,
    "recruiter_pattern":      12,
    "finance_pattern":        10,
    "social_update":          10,
    "urgency_tactic":         18,
    "suspicious_link":        22,
    "spoofed_sender":         20,
    "security_alert":         16,
    "otp_transactional":     -30,
    "order_confirmation":    -20,
    "meeting_calendar":      -25,
    "personal_reply_signal": -20,
}

# ── Pattern Libraries ──────────────────────────────────────────────────────────
PATTERNS = {
    "unsubscribe_footer": [
        r"unsubscribe", r"opt.?out", r"manage.*preference",
        r"email.*preference", r"no longer.*receive", r"stop receiving",
    ],
    "bulk_sender_pattern": [
        r"noreply@", r"no-reply@", r"donotreply@", r"mailer@",
        r"newsletter@", r"updates@", r"notifications@", r"info@.*\.(com|io|co)",
    ],
    "marketing_language": [
        r"\b(sale|deal|offer|discount|promo|coupon|save \d+%|% off|limited time"
        r"|exclusive|free shipping|flash sale|today only|hurry|act now)\b",
    ],
    "promotional_subject": [
        r"\b(introducing|announcing|new arrival|back in stock|just launched"
        r"|black friday|cyber monday|holiday sale|clearance|special offer"
        r"|early access|member.*benefit)\b",
    ],
    "newsletter_pattern": [
        r"\b(weekly digest|monthly roundup|newsletter|issue #\d+|vol\.\s*\d+"
        r"|edition|curated for you|top stories|what.*reading this week)\b",
    ],
    "recruiter_pattern": [
        r"\b(job opportunity|exciting role|open position|we.*hiring"
        r"|career opportunity|your.*profile|impressed by your|great fit"
        r"|software engineer.*position|reach out.*opportunity)\b",
    ],
    "finance_pattern": [
        r"\b(invoice|receipt|payment|transaction|statement|billing"
        r"|account summary|due date|subscription renewed|charge)\b",
    ],
    "social_update": [
        r"\b(liked your|commented on|mentioned you|new follower|friend request"
        r"|connection request|reacted to|tagged you)\b",
    ],
    "urgency_tactic": [
        r"\b(urgent|immediate action|account.*suspend|verify.*account"
        r"|update.*payment|confirm.*identity|24 hours|will be closed"
        r"|suspicious activity|unauthorized access)\b",
    ],
    "suspicious_link": [
        r"bit\.ly/", r"tinyurl\.com/", r"goo\.gl/", r"ow\.ly/",
        r"http://[^\s]+\.(xyz|top|click|tk|ml|ga|cf)",
        r"paypal.*security.*update",
        r"verify.*account.*click.*here",
    ],
    "spoofed_sender": [
        r"paypal.*@(?!paypal\.com)",
        r"amazon.*@(?!amazon\.com)",
        r"google.*@(?!google\.com)",
        r"apple.*@(?!apple\.com)",
        r"microsoft.*@(?!microsoft\.com)",
    ],
    "security_alert": [
        r"\b(security alert|new sign.?in|login attempt|password.*change"
        r"|two.factor|verification code|otp|one.time password)\b",
    ],
    "otp_transactional": [
        r"\b(otp|one.time password|verification code|confirm.*login"
        r"|\d{4,8}.*code|your code is|authentication code)\b",
    ],
    "order_confirmation": [
        r"\b(order.*confirm|shipped|delivery|tracking number|your receipt"
        r"|booking confirm|reservation confirm|ticket.*confirm)\b",
    ],
    "meeting_calendar": [
        r"\b(meeting|interview|scheduled|calendar invite|zoom|google meet"
        r"|teams meeting|sync at|standup|call at \d)\b",
    ],
    "personal_reply_signal": [
        r"^re:", r"^fwd:", r"^fw:", r"in response to",
        r"as discussed", r"following up",
    ],
}

# ── Category Rules ─────────────────────────────────────────────────────────────
CATEGORY_MAP = {
    "Phishing Risk":    lambda s: s["suspicious_link"] or s["spoofed_sender"] or s["urgency_tactic"],
    "Security Alert":  lambda s: s["security_alert"] and not (s["suspicious_link"] or s["spoofed_sender"]),
    "OTP / Auth":      lambda s: s["otp_transactional"],
    "Finance":         lambda s: s["finance_pattern"] and not s["suspicious_link"],
    "Order Update":    lambda s: s["order_confirmation"],
    "Recruiter":       lambda s: s["recruiter_pattern"],
    "Newsletter":      lambda s: s["newsletter_pattern"] or (s["unsubscribe_footer"] and s["bulk_sender_pattern"]),
    "Promotion":       lambda s: s["marketing_language"] or s["promotional_subject"],
    "Social Update":   lambda s: s["social_update"],
    "Meeting / Event": lambda s: s["meeting_calendar"],
    "Important":       lambda s: s["personal_reply_signal"] or s["meeting_calendar"],
}

LABEL_FOR_CATEGORY = {
    "Phishing Risk":   "AI/Phishing Risk",
    "Security Alert":  "AI/Security",
    "OTP / Auth":      "AI/Transactional",
    "Finance":         "AI/Finance",
    "Order Update":    "AI/Orders",
    "Recruiter":       "AI/Recruiters",
    "Newsletter":      "AI/Newsletters",
    "Promotion":       "AI/Promotions",
    "Social Update":   "AI/Social",
    "Meeting / Event": "AI/Calendar",
    "Important":       "AI/Important",
}

REMOVE_FROM_INBOX = {"Newsletter", "Promotion", "Social Update", "Phishing Risk"}


def _check(text: str, pattern_key: str) -> bool:
    text_lower = text.lower()
    return any(re.search(p, text_lower) for p in PATTERNS[pattern_key])


def score_email(subject: str, sender: str, body_snippet: str = "", headers: dict = None) -> dict:
    """
    Score a single email. Returns full classification result.
    All local — zero API calls.
    """
    full_text = f"{subject} {sender} {body_snippet}"
    headers = headers or {}

    # Evaluate each signal
    signals = {key: _check(full_text, key) for key in PATTERNS}

    # Extra signals from headers
    if headers.get("List-Unsubscribe"):
        signals["unsubscribe_footer"] = True
    if headers.get("Precedence") in ("bulk", "list"):
        signals["bulk_sender_pattern"] = True

    # Compute total score
    total = sum(WEIGHTS[k] * int(v) for k, v in signals.items())

    # Determine category
    category = "Uncategorized"
    for cat, rule in CATEGORY_MAP.items():
        if rule(signals):
            category = cat
            break

    if category == "Uncategorized" and total > 10:
        category = "Promotion"

    label = LABEL_FOR_CATEGORY.get(category, "AI/Uncategorized")
    archive = category in REMOVE_FROM_INBOX

    # Build explanation
    reasons = []
    if signals["unsubscribe_footer"]:    reasons.append("Unsubscribe footer detected")
    if signals["bulk_sender_pattern"]:   reasons.append("Bulk/no-reply sender")
    if signals["marketing_language"]:    reasons.append("Marketing language in body")
    if signals["promotional_subject"]:   reasons.append("Promotional subject line")
    if signals["newsletter_pattern"]:    reasons.append("Newsletter pattern found")
    if signals["recruiter_pattern"]:     reasons.append("Recruiter outreach pattern")
    if signals["suspicious_link"]:       reasons.append("Suspicious/shortened link")
    if signals["spoofed_sender"]:        reasons.append("Possible sender spoofing")
    if signals["urgency_tactic"]:        reasons.append("Urgency/scare tactics detected")
    if signals["otp_transactional"]:     reasons.append("Transactional / OTP email")
    if signals["order_confirmation"]:    reasons.append("Order or booking confirmation")
    if signals["meeting_calendar"]:      reasons.append("Meeting or calendar event")
    if signals["personal_reply_signal"]: reasons.append("Looks like a personal reply")

    confidence = min(99, max(30, 50 + total))

    return {
        "category":   category,
        "label":      label,
        "score":      total,
        "confidence": confidence,
        "archive":    archive,
        "reasons":    reasons if reasons else ["No strong signals detected"],
        "signals":    signals,
    }


def batch_score(emails: list) -> list:
    """Score a list of email dicts."""
    results = []
    for e in emails:
        result = score_email(
            subject=e.get("subject", ""),
            sender=e.get("from", ""),
            body_snippet=e.get("snippet", ""),
            headers=e.get("headers", {}),
        )
        results.append({**e, **result})
    return results


def inbox_analytics(scored_emails: list) -> dict:
    """Generate lightweight inbox analytics."""
    total = len(scored_emails)
    cats = {}
    phishing = 0
    archiveable = 0

    for e in scored_emails:
        cat = e.get("category", "Uncategorized")
        cats[cat] = cats.get(cat, 0) + 1
        if cat == "Phishing Risk":
            phishing += 1
        if e.get("archive"):
            archiveable += 1

    clutter_score = round((archiveable / total * 100) if total else 0)

    return {
        "total":          total,
        "categories":     cats,
        "phishing_count": phishing,
        "archiveable":    archiveable,
        "clutter_score":  clutter_score,
    }

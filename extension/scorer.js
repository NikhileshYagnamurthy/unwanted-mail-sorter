/**
 * InboxAI — Lightweight Scoring Engine (JavaScript Port)
 * 
 * Ported from scorer.py to run locally in the Chrome Extension.
 * Ensures identical classification results.
 */

const WEIGHTS = {
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
};

const PATTERNS = {
    "unsubscribe_footer": [
        /unsubscribe/i, /opt.?out/i, /manage.*preference/i,
        /email.*preference/i, /no longer.*receive/i, /stop receiving/i,
    ],
    "bulk_sender_pattern": [
        /noreply@/i, /no-reply@/i, /donotreply@/i, /mailer@/i,
        /newsletter@/i, /updates@/i, /notifications@/i, /info@.*\.(com|io|co)/i,
    ],
    "marketing_language": [
        /\b(sale|deal|offer|discount|promo|coupon|save \d+%|% off|limited time|exclusive|free shipping|flash sale|today only|hurry|act now)\b/i,
    ],
    "promotional_subject": [
        /\b(introducing|announcing|new arrival|back in stock|just launched|black friday|cyber monday|holiday sale|clearance|special offer|early access|member.*benefit)\b/i,
    ],
    "newsletter_pattern": [
        /\b(weekly digest|monthly roundup|newsletter|issue #\d+|vol\.\s*\d+|edition|curated for you|top stories|what.*reading this week)\b/i,
    ],
    "recruiter_pattern": [
        /\b(job opportunity|exciting role|open position|we.*hiring|career opportunity|your.*profile|impressed by your|great fit|software engineer.*position|reach out.*opportunity)\b/i,
    ],
    "finance_pattern": [
        /\b(invoice|receipt|payment|transaction|statement|billing|account summary|due date|subscription renewed|charge)\b/i,
    ],
    "social_update": [
        /\b(liked your|commented on|mentioned you|new follower|friend request|connection request|reacted to|tagged you)\b/i,
    ],
    "urgency_tactic": [
        /\b(urgent|immediate action|account.*suspend|verify.*account|update.*payment|confirm.*identity|24 hours|will be closed|suspicious activity|unauthorized access)\b/i,
    ],
    "suspicious_link": [
        /bit\.ly\//i, /tinyurl\.com\//i, /goo\.gl\//i, /ow\.ly\//i,
        /http:\/\/[^\s]+\.(xyz|top|click|tk|ml|ga|cf)/i,
        /paypal.*security.*update/i,
        /verify.*account.*click.*here/i,
    ],
    "spoofed_sender": [
        /paypal.*@(?!paypal\.com)/i,
        /amazon.*@(?!amazon\.com)/i,
        /google.*@(?!google\.com)/i,
        /apple.*@(?!apple\.com)/i,
        /microsoft.*@(?!microsoft\.com)/i,
    ],
    "security_alert": [
        /\b(security alert|new sign.?in|login attempt|password.*change|two.factor|verification code|otp|one.time password)\b/i,
    ],
    "otp_transactional": [
        /\b(otp|one.time password|verification code|confirm.*login|\d{4,8}.*code|your code is|authentication code)\b/i,
    ],
    "order_confirmation": [
        /\b(order.*confirm|shipped|delivery|tracking number|your receipt|booking confirm|reservation confirm|ticket.*confirm)\b/i,
    ],
    "meeting_calendar": [
        /\b(meeting|interview|scheduled|calendar invite|zoom|google meet|teams meeting|sync at|standup|call at \d)\b/i,
    ],
    "personal_reply_signal": [
        /^re:/i, /^fwd:/i, /^fw:/i, /in response to/i,
        /as discussed/i, /following up/i,
    ],
};

const CATEGORY_MAP = {
    "Phishing Risk":    s => s["suspicious_link"] || s["spoofed_sender"] || s["urgency_tactic"],
    "Security Alert":  s => s["security_alert"] && !(s["suspicious_link"] || s["spoofed_sender"]),
    "OTP / Auth":      s => s["otp_transactional"],
    "Finance":         s => s["finance_pattern"] && !s["suspicious_link"],
    "Order Update":    s => s["order_confirmation"],
    "Recruiter":       s => s["recruiter_pattern"],
    "Newsletter":      s => s["newsletter_pattern"] || (s["unsubscribe_footer"] && s["bulk_sender_pattern"]),
    "Promotion":       s => s["marketing_language"] || s["promotional_subject"],
    "Social Update":   s => s["social_update"],
    "Meeting / Event": s => s["meeting_calendar"],
    "Important":       s => s["personal_reply_signal"] || s["meeting_calendar"],
};

const LABEL_FOR_CATEGORY = {
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
};

const REMOVE_FROM_INBOX = new Set(["Newsletter", "Promotion", "Social Update", "Phishing Risk"]);

function _check(text, patternKey) {
    return PATTERNS[patternKey].some(regex => regex.test(text));
}

function scoreEmail(subject, sender, bodySnippet = "", headers = {}) {
    const fullText = `${subject} ${sender} ${bodySnippet}`;
    
    // Evaluate each signal
    const signals = {};
    for (const key in PATTERNS) {
        signals[key] = _check(fullText, key);
    }

    // Extra signals from headers
    if (headers["List-Unsubscribe"]) {
        signals["unsubscribe_footer"] = true;
    }
    if (headers["Precedence"] === "bulk" || headers["Precedence"] === "list") {
        signals["bulk_sender_pattern"] = true;
    }

    // Compute total score
    let total = 0;
    for (const k in signals) {
        if (signals[k]) {
            total += WEIGHTS[k];
        }
    }

    // Determine category
    let category = "Uncategorized";
    for (const [cat, rule] of Object.entries(CATEGORY_MAP)) {
        if (rule(signals)) {
            category = cat;
            break;
        }
    }

    if (category === "Uncategorized" && total > 10) {
        category = "Promotion";
    }

    const label = LABEL_FOR_CATEGORY[category] || "AI/Uncategorized";
    const archive = REMOVE_FROM_INBOX.has(category);

    // Build explanation
    const reasons = [];
    if (signals["unsubscribe_footer"])    reasons.push("Unsubscribe footer detected");
    if (signals["bulk_sender_pattern"])   reasons.push("Bulk/no-reply sender");
    if (signals["marketing_language"])    reasons.push("Marketing language in body");
    if (signals["promotional_subject"])   reasons.push("Promotional subject line");
    if (signals["newsletter_pattern"])    reasons.push("Newsletter pattern found");
    if (signals["recruiter_pattern"])     reasons.push("Recruiter outreach pattern");
    if (signals["suspicious_link"])       reasons.push("Suspicious/shortened link");
    if (signals["spoofed_sender"])        reasons.push("Possible sender spoofing");
    if (signals["urgency_tactic"])        reasons.push("Urgency/scare tactics detected");
    if (signals["otp_transactional"])     reasons.push("Transactional / OTP email");
    if (signals["order_confirmation"])    reasons.push("Order or booking confirmation");
    if (signals["meeting_calendar"])      reasons.push("Meeting or calendar event");
    if (signals["personal_reply_signal"]) reasons.push("Looks like a personal reply");

    const confidence = Math.min(99, Math.max(30, 50 + total));

    return {
        "category":   category,
        "label":      label,
        "score":      total,
        "confidence": confidence,
        "archive":    archive,
        "reasons":    reasons.length > 0 ? reasons : ["No strong signals detected"],
        "signals":    signals,
    };
}

function batchScore(emails) {
    return emails.map(e => {
        const result = scoreEmail(
            e.subject || "",
            e.from || "",
            e.snippet || "",
            e.headers || {}
        );
        return { ...e, ...result };
    });
}

function inboxAnalytics(scoredEmails) {
    const total = scoredEmails.length;
    const cats = {};
    let phishing = 0;
    let archiveable = 0;

    scoredEmails.forEach(e => {
        const cat = e.category || "Uncategorized";
        cats[cat] = (cats[cat] || 0) + 1;
        if (cat === "Phishing Risk") {
            phishing += 1;
        }
        if (e.archive) {
            archiveable += 1;
        }
    });

    const clutter_score = total ? Math.round((archiveable / total) * 100) : 0;

    return {
        "total":          total,
        "categories":     cats,
        "phishing_count": phishing,
        "archiveable":    archiveable,
        "clutter_score":  clutter_score,
    };
}

// Export for parity testing if in Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scoreEmail, batchScore, inboxAnalytics };
}

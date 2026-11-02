/**
 * InboxAI — Scoring Engine v2
 * 
 * Changes from v1:
 * - Added automated_sender, ecommerce, generic_marketing, banking, notification patterns
 * - Indian email context (Swiggy, Zomato, Flipkart, Jio, HDFC, etc.)
 * - Fixed catch-all: bulk/automated senders now always classify instead of falling through
 * - Lowered promotion fallback threshold from >10 to >0
 * - "Uncategorized" now only for genuinely ambiguous personal-looking emails
 */

const WEIGHTS = {
    "unsubscribe_footer":     20,
    "bulk_sender_pattern":    18,
    "automated_sender":       14,
    "marketing_language":     15,
    "promotional_subject":    15,
    "newsletter_pattern":     14,
    "generic_marketing":      12,
    "ecommerce_pattern":      10,
    "banking_pattern":        10,
    "notification_pattern":    8,
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
    // ── Original patterns ────────────────────────────────────────────────────
    "unsubscribe_footer": [
        /unsubscribe/i, /opt.?out/i, /manage.*preference/i,
        /email.*preference/i, /no longer.*receive/i, /stop receiving/i,
    ],
    "bulk_sender_pattern": [
        /noreply@/i, /no-reply@/i, /no\.reply@/i, /donotreply@/i,
        /do-not-reply@/i, /mailer@/i, /newsletter@/i, /updates@/i,
        /notifications?@/i, /info@.*\.(com|io|co|in)/i,
        /alerts?@/i, /offers?@/i, /deals?@/i, /promo@/i,
        /marketing@/i, /news@/i, /digest@/i,
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
        /\b(job opportunity|exciting role|open position|we.*hiring|career opportunity|your.*profile|impressed by your|great fit|software engineer.*position|reach out.*opportunity|job opening|full.?time|part.?time.*role|compensation|joining date|lpa|per annum|ctc)\b/i,
    ],
    "finance_pattern": [
        /\b(invoice|receipt|payment|transaction|statement|billing|account summary|due date|subscription renewed|charge|amount paid|debit|credit card|bank|emi|loan|insurance)\b/i,
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
        /amazon.*@(?!amazon\.(com|in))/i,
        /google.*@(?!google\.com)/i,
        /apple.*@(?!apple\.com)/i,
        /microsoft.*@(?!microsoft\.com)/i,
        /hdfc.*@(?!hdfcbank\.com)/i,
        /sbi.*@(?!sbi\.co\.in)/i,
    ],
    "security_alert": [
        /\b(security alert|new sign.?in|login attempt|password.*change|two.factor|verification code|otp|one.time password)\b/i,
    ],
    "otp_transactional": [
        /\b(otp|one.time password|verification code|confirm.*login|\d{4,8}.*code|your code is|authentication code|use this code|expir.*\d+ min)\b/i,
    ],
    "order_confirmation": [
        /\b(order.*confirm|shipped|delivery|tracking number|your receipt|booking confirm|reservation confirm|ticket.*confirm|order.*placed|order.*dispatch|out for delivery|delivered)\b/i,
    ],
    "meeting_calendar": [
        /\b(meeting|interview|scheduled|calendar invite|zoom|google meet|teams meeting|sync at|standup|call at \d|webinar|joining link)\b/i,
    ],
    "personal_reply_signal": [
        /^re:/i, /^fwd:/i, /^fw:/i, /in response to/i,
        /as discussed/i, /following up/i, /as per our/i,
    ],

    // ── NEW patterns ─────────────────────────────────────────────────────────

    // Automated system senders that aren't covered by bulk_sender_pattern
    "automated_sender": [
        /support@/i, /hello@/i, /team@/i, /contact@/i,
        /help@/i, /service@/i, /care@/i, /admin@/i,
        /accounts?@/i, /billing@/i, /payments?@/i,
        /orders?@/i, /shipping@/i, /delivery@/i,
        /@.*\.(zomato|swiggy|flipkart|amazon|myntra|meesho|ajio|nykaa|blinkit|bigbasket)\.com/i,
        /@.*(jio|airtel|vi|bsnl|vodafone)\.(com|in)/i,
        /@.*(hdfc|icici|sbi|axis|kotak|paytm|phonepe|gpay|razorpay)\.(com|in)/i,
    ],

    // Ecommerce/delivery — more aggressive than order_confirmation
    "ecommerce_pattern": [
        /\b(cart|wishlist|track|shipment|COD|cash on delivery|placed.*order|order.*id|order.*no|invoice no)\b/i,
        /\b(flipkart|amazon\.in|myntra|meesho|ajio|nykaa|swiggy|zomato|blinkit|bigbasket|jiomart|snapdeal)\b/i,
        /\b(estimated delivery|expected by|arriving|package|parcel|courier|logistics)\b/i,
    ],

    // Generic marketing that doesn't fit specific buckets
    "generic_marketing": [
        /\b(dear customer|dear user|dear member|hi there|hello there|valued customer|dear subscriber)\b/i,
        /\b(check out|don't miss|grab now|shop now|buy now|get it now|limited stock|selling fast|almost gone)\b/i,
        /\b(cashback|voucher|reward|points|spin|win|lucky draw|contest|giveaway|festive|season sale)\b/i,
        /\b(upgrade your|renew your|activate your|unlock|premium access|exclusive.*member)\b/i,
        /\b(\d+% off|\d+ rupees? off|flat \d+|extra \d+%|upto \d+%|save upto|min.*order|free delivery)\b/i,
    ],

    // Banking / financial services alerts (non-phishing)
    "banking_pattern": [
        /\b(account.*credited|account.*debited|a\/c.*credited|a\/c.*debited|rs\.?\s*\d+|inr\s*\d+)\b/i,
        /\b(UPI|IMPS|NEFT|RTGS|net banking|mobile banking|e-statement|bank statement|passbook)\b/i,
        /\b(credit card.*statement|card.*due|minimum.*due|payment.*due|bill.*generated)\b/i,
        /\b(mutual fund|investment|portfolio|sip|nav|dividend|interest credited)\b/i,
    ],

    // System/service notifications
    "notification_pattern": [
        /\b(your account|account.*update|profile.*update|password.*reset|sign.?in|logged in|device.*authorized)\b/i,
        /\b(subscription|plan.*expire|trial.*end|renewal|auto.renew|next billing|invoice.*ready)\b/i,
        /\b(new message|you have \d+|pending|reminder|follow.?up|action required|response needed)\b/i,
        /\b(github|jira|slack|notion|figma|trello|asana|monday|linear)\b/i,
    ],
};

// ── Category Rules ─────────────────────────────────────────────────────────────
// Order matters — first match wins
const CATEGORY_MAP = {
    "Phishing Risk":    s => s["suspicious_link"] || s["spoofed_sender"],
    "Security Alert":  s => s["security_alert"] && !(s["suspicious_link"] || s["spoofed_sender"]) && !s["otp_transactional"],
    "OTP / Auth":      s => s["otp_transactional"],
    "Order Update":    s => s["order_confirmation"] || s["ecommerce_pattern"],
    "Finance":         s => (s["finance_pattern"] || s["banking_pattern"]) && !s["suspicious_link"],
    "Recruiter":       s => s["recruiter_pattern"],
    "Newsletter":      s => s["newsletter_pattern"] || (s["unsubscribe_footer"] && (s["bulk_sender_pattern"] || s["automated_sender"])),
    "Promotion":       s => s["marketing_language"] || s["promotional_subject"] || s["generic_marketing"],
    "Social Update":   s => s["social_update"],
    "Meeting / Event": s => s["meeting_calendar"],
    "Important":       s => s["personal_reply_signal"],
    "Notification":    s => s["notification_pattern"],
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
    "Notification":    "AI/Transactional",
};

// Categories that should be auto-archived
const REMOVE_FROM_INBOX = new Set(["Newsletter", "Promotion", "Social Update", "Phishing Risk"]);

function _check(text, patternKey) {
    return PATTERNS[patternKey].some(regex => regex.test(text));
}

function scoreEmail(subject, sender, bodySnippet = "", headers = {}) {
    const fullText = `${subject} ${sender} ${bodySnippet}`;

    // Evaluate every signal
    const signals = {};
    for (const key in PATTERNS) {
        signals[key] = _check(fullText, key);
    }

    // Header-based overrides (more reliable than text matching)
    if (headers["List-Unsubscribe"]) {
        signals["unsubscribe_footer"] = true;
    }
    if (headers["Precedence"] === "bulk" || headers["Precedence"] === "list") {
        signals["bulk_sender_pattern"] = true;
    }

    // Compute total score
    let total = 0;
    for (const k in signals) {
        if (signals[k] && WEIGHTS[k] !== undefined) {
            total += WEIGHTS[k];
        }
    }

    // ── Determine category ───────────────────────────────────────────────────
    let category = "Uncategorized";
    for (const [cat, rule] of Object.entries(CATEGORY_MAP)) {
        if (rule(signals)) {
            category = cat;
            break;
        }
    }

    // ── Improved catch-all logic ─────────────────────────────────────────────
    // Old: only promote to "Promotion" if total > 10
    // New: tiered fallback based on sender signals — much fewer "Uncategorized"
    if (category === "Uncategorized") {
        if (signals["urgency_tactic"]) {
            // Urgency without phishing signals = likely a service alert
            category = "Security Alert";
        } else if (signals["bulk_sender_pattern"] || signals["automated_sender"]) {
            // Automated/no-reply sender with no clearer match = Promotion
            category = "Promotion";
        } else if (signals["unsubscribe_footer"]) {
            // Has unsubscribe link = marketing of some kind
            category = "Newsletter";
        } else if (signals["banking_pattern"] || signals["finance_pattern"]) {
            category = "Finance";
        } else if (total > 0) {
            // Some positive signal, just not enough for a specific category
            category = "Promotion";
        }
        // total <= 0 and no automated sender = likely personal → stays Uncategorized
    }

    const label = LABEL_FOR_CATEGORY[category] || "AI/Uncategorized";
    const archive = REMOVE_FROM_INBOX.has(category);

    // ── Build explanation reasons ────────────────────────────────────────────
    const reasons = [];
    if (signals["unsubscribe_footer"])    reasons.push("Unsubscribe footer detected");
    if (signals["bulk_sender_pattern"])   reasons.push("Bulk/no-reply sender");
    if (signals["automated_sender"])      reasons.push("Automated service sender");
    if (signals["marketing_language"])    reasons.push("Marketing language");
    if (signals["promotional_subject"])   reasons.push("Promotional subject line");
    if (signals["newsletter_pattern"])    reasons.push("Newsletter pattern found");
    if (signals["generic_marketing"])     reasons.push("Generic marketing language");
    if (signals["ecommerce_pattern"])     reasons.push("Ecommerce/delivery email");
    if (signals["banking_pattern"])       reasons.push("Banking/financial alert");
    if (signals["notification_pattern"])  reasons.push("Service notification");
    if (signals["recruiter_pattern"])     reasons.push("Recruiter outreach");
    if (signals["suspicious_link"])       reasons.push("Suspicious/shortened link");
    if (signals["spoofed_sender"])        reasons.push("Possible sender spoofing");
    if (signals["urgency_tactic"])        reasons.push("Urgency/scare tactics");
    if (signals["otp_transactional"])     reasons.push("Transactional / OTP email");
    if (signals["order_confirmation"])    reasons.push("Order or booking confirmation");
    if (signals["meeting_calendar"])      reasons.push("Meeting or calendar event");
    if (signals["personal_reply_signal"]) reasons.push("Looks like a personal reply");
    if (signals["finance_pattern"])       reasons.push("Finance/payment email");
    if (signals["social_update"])         reasons.push("Social network update");

    const confidence = Math.min(99, Math.max(30, 50 + total));

    return {
        category,
        label,
        score:      total,
        confidence,
        archive,
        reasons:    reasons.length > 0 ? reasons : ["No strong signals — classified by sender type"],
        signals,
    };
}

function batchScore(emails) {
    return emails.map(e => {
        const result = scoreEmail(
            e.subject  || "",
            e.from     || "",
            e.snippet  || "",
            e.headers  || {}
        );
        return { ...e, ...result };
    });
}

function inboxAnalytics(scoredEmails) {
    const total = scoredEmails.length;
    const cats  = {};
    let phishing    = 0;
    let archiveable = 0;

    scoredEmails.forEach(e => {
        const cat = e.category || "Uncategorized";
        cats[cat] = (cats[cat] || 0) + 1;
        if (cat === "Phishing Risk") phishing++;
        if (e.archive) archiveable++;
    });

    return {
        total,
        categories:     cats,
        phishing_count: phishing,
        archiveable,
        clutter_score:  total ? Math.round((archiveable / total) * 100) : 0,
    };
}

export { scoreEmail, batchScore, inboxAnalytics };

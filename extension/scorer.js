/**
 * InboxAI — Classification Engine v3 (on-device, heuristic, no network)
 *
 * PUBLIC API — unchanged from v2, so background.js / popup.js need no edits:
 *     scoreEmail(subject, sender, snippet, headers) -> result
 *     batchScore(emails)                            -> emails + result fields
 *     inboxAnalytics(scoredEmails)                  -> analytics
 *
 * RESULT SHAPE — a superset of v2:
 *     category, label, score, confidence, archive, reasons, signals   (v2 fields)
 *     scores, phishing                                                (new, debug/explain)
 *
 * WHY v3 (root causes of v2 misclassification):
 *   1. First-match-wins boolean rules: Newsletter/Promotion were checked before
 *      Social/Meeting, so those could never win; a List-Unsubscribe header alone
 *      meant "Newsletter".
 *   2. Sender address was concatenated into the text and matched by content
 *      regexes. `/google.*@(?!google\.com)/` flagged every *.google.com
 *      subdomain (accounts.google.com) as spoofed.
 *   3. Single common words (shipped, delivery, brand names, "profile", "account")
 *      were treated as category evidence.
 *   4. Fallbacks forced any automated sender into "Promotion" and archived it.
 *   5. Confidence was 50 + sum(all signals): meaningless, 99% on wrong answers.
 *
 * HOW v3 WORKS:
 *   - Parse the sender (name / local part / registrable domain) and keep it
 *     separate from subject and snippet text.
 *   - Collect evidence per category from independent FAMILIES (subject structure,
 *     body phrases, sender domain, sender role, bulk header). Each family counts
 *     once per category (max, not sum), so keyword spam cannot stack.
 *   - Bulk headers corroborate Newsletter/Promotion/Social but never create them.
 *   - Phishing needs DECEPTION evidence (brand impersonation, abuse TLD, link
 *     shorteners, ...). Alarming words alone never trigger it, and mail from a
 *     brand's own domain is exempt.
 *   - Winner = highest category score, ties broken toward "keep in inbox".
 *     Below CATEGORY_MIN_SCORE the email stays Uncategorized.
 *   - Confidence comes from score AND margin over the runner-up.
 *   - Auto-archive requires an archivable category AND confidence >= threshold.
 *
 * KNOWN LIMITS: the Gmail snippet is ~100-200 chars; From can be forged (no
 * SPF/DKIM visibility); the brand/domain registries are finite and India-leaning.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Tunable constants (every threshold in one place)
// ═════════════════════════════════════════════════════════════════════════════
const CATEGORY_MIN_SCORE     = 35;   // below this, stay Uncategorized
const PHISH_MIN_SCORE        = 45;   // phishing score needed (plus deception)
const ARCHIVE_MIN_CONFIDENCE = 70;   // auto-archive only when this sure (set 0 to restore v2 behaviour)
const SNIPPET_FACTOR         = 0.75; // snippet text is truncated/noisy: count less than subject
const PERSONAL_DAMPEN        = 0.5;  // mail from a personal (free-mail) address, non-bulk
const BULK_CORROBORATION     = 20;   // bulk header bonus when content evidence already exists
const BULK_WEAK              = 8;    // bulk header alone: nearly nothing

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

// Categories that may be auto-archived (and only when confident enough)
const REMOVE_FROM_INBOX = new Set(["Newsletter", "Promotion", "Social Update", "Phishing Risk"]);

// Tie-break order: when two categories score equally, prefer the one that keeps
// the email in the inbox. "When in doubt, don't archive."
const TIE_BREAK = [
    "OTP / Auth", "Security Alert", "Finance", "Order Update", "Recruiter",
    "Meeting / Event", "Social Update", "Notification", "Important",
    "Newsletter", "Promotion",
];

// ═════════════════════════════════════════════════════════════════════════════
// Sender parsing & knowledge
// ═════════════════════════════════════════════════════════════════════════════
const MULTI_PART_TLDS = new Set([
    "co.in", "ac.in", "org.in", "gov.in", "nic.in", "edu.in", "net.in", "res.in",
    "co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "com.br", "co.za", "co.nz",
]);

const FREEMAIL = new Set([
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "outlook.com",
    "hotmail.com", "live.com", "rediffmail.com", "proton.me", "protonmail.com", "icloud.com",
]);

// TLDs heavily abused for phishing/spam
const SUSPICIOUS_TLDS = new Set([
    "xyz", "top", "click", "tk", "ml", "ga", "cf", "gq", "loan", "win", "racing",
    "download", "icu", "buzz", "monster", "rest", "cyou", "sbs", "zip", "mov",
]);

function rootDomain(host) {
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const lastTwo = parts.slice(-2).join(".");
    return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function parseSender(from) {
    const raw = (from || "").trim();
    const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const name    = (m ? m[1] : "").trim();
    const address = (m ? m[2] : raw).trim().toLowerCase();
    const at      = address.lastIndexOf("@");
    const local   = at >= 0 ? address.slice(0, at) : address;
    const host    = at >= 0 ? address.slice(at + 1) : "";
    const root    = rootDomain(host);
    const tld     = root.split(".").pop() || "";
    return { name, address, local, host, root, tld };
}

// Brands we can verify. If a message claims a brand but is NOT from one of its
// official domains, that is impersonation evidence; if it IS, phishing is ruled out.
const BRANDS = [
    ["paypal",    /\bpaypal\b/i,        ["paypal.com", "paypal.in"]],
    ["amazon",    /\bamazon\b/i,        ["amazon.com", "amazon.in", "amazon.co.uk", "amazon.de", "amazonpay.in", "primevideo.com"]],
    ["google",    /\bgoogle\b/i,        ["google.com", "googlemail.com", "youtube.com", "withgoogle.com"]],
    ["microsoft", /\bmicrosoft\b/i,     ["microsoft.com", "live.com", "outlook.com", "office.com", "microsoftonline.com", "windows.com", "xbox.com", "skype.com"]],
    ["apple",     /\bapple\b/i,         ["apple.com", "icloud.com"]],
    ["netflix",   /\bnetflix\b/i,       ["netflix.com"]],
    ["facebook",  /\bfacebook\b/i,      ["facebook.com", "facebookmail.com", "fb.com", "meta.com"]],
    ["instagram", /\binstagram\b/i,     ["instagram.com"]],
    ["linkedin",  /\blinkedin\b/i,      ["linkedin.com"]],
    ["github",    /\bgithub\b/i,        ["github.com"]],
    ["dropbox",   /\bdropbox\b/i,       ["dropbox.com", "dropboxmail.com"]],
    ["spotify",   /\bspotify\b/i,       ["spotify.com"]],
    ["whatsapp",  /\bwhatsapp\b/i,      ["whatsapp.com"]],
    ["hdfc",      /\bhdfc\b/i,          ["hdfcbank.com", "hdfcbank.net", "hdfc.com", "hdfclife.com", "hdfcsec.com", "hdfcfund.com", "hdfcergo.com"]],
    ["icici",     /\bicici\b/i,         ["icicibank.com", "icicilombard.com", "iciciprulife.com", "icicisecurities.com", "icicidirect.com"]],
    ["sbi",       /\bsbi\b/i,           ["sbi.co.in", "onlinesbi.sbi", "sbicard.com", "sbilife.co.in", "sbimf.com", "sbi.bank.in"]],
    ["axis",      /\baxis bank\b/i,     ["axisbank.com"]],
    ["kotak",     /\bkotak\b/i,         ["kotak.com"]],
    ["paytm",     /\bpaytm\b/i,         ["paytm.com", "paytmbank.com"]],
    ["phonepe",   /\bphonepe\b/i,       ["phonepe.com"]],
    ["flipkart",  /\bflipkart\b/i,      ["flipkart.com"]],
    ["irctc",     /\birctc\b/i,         ["irctc.co.in"]],
    ["indiapost", /\bindia ?post\b/i,   ["indiapost.gov.in"]],
    ["dhl",       /\bdhl\b/i,         ["dhl.com", "dhl.de", "dhl.co.in"]],
    ["fedex",     /\bfedex\b/i,       ["fedex.com"]],
    ["bluedart",  /\bblue ?dart\b/i,  ["bluedart.com"]],
    ["delhivery", /\bdelhivery\b/i,   ["delhivery.com"]],
    ["swiggy",    /\bswiggy\b/i,        ["swiggy.in", "swiggy.com"]],
    ["zomato",    /\bzomato\b/i,        ["zomato.com"]],
];

const OFFICIAL_DOMAINS = new Set(BRANDS.flatMap(b => b[2]));

// Sender-domain priors (weak evidence: they tilt, subject/body decide)
const DOMAINS = {
    social:   new Set(["facebook.com", "facebookmail.com", "fb.com", "instagram.com", "linkedin.com", "x.com",
                       "twitter.com", "pinterest.com", "reddit.com", "redditmail.com", "discord.com",
                       "snapchat.com", "tiktok.com", "quora.com", "threads.net"]),
    jobs:     new Set(["naukri.com", "indeed.com", "glassdoor.com", "internshala.com", "foundit.in", "monster.com",
                       "wellfound.com", "instahyre.com", "apna.co", "shine.com", "cutshort.io", "unstop.com"]),
    finance:  new Set(["hdfcbank.com", "hdfcbank.net", "icicibank.com", "sbi.co.in", "onlinesbi.sbi", "sbicard.com",
                       "axisbank.com", "kotak.com", "paytm.com", "phonepe.com", "razorpay.com", "stripe.com",
                       "paypal.com", "groww.in", "zerodha.com", "licindia.com", "licindia.in", "bajajfinserv.in",
                       "cred.club", "hdfclife.com", "hdfcsec.com"]),
    commerce: new Set(["amazon.in", "amazon.com", "flipkart.com", "myntra.com", "swiggy.in", "swiggy.com",
                       "zomato.com", "ajio.com", "nykaa.com", "meesho.com", "blinkit.com", "bigbasket.com",
                       "jiomart.com", "snapdeal.com", "irctc.co.in", "makemytrip.com", "redbus.in", "bookmyshow.com"]),
    devtools: new Set(["github.com", "gitlab.com", "vercel.com", "render.com", "netlify.com", "slack.com",
                       "notion.so", "makenotion.com", "figma.com", "atlassian.com", "atlassian.net", "trello.com",
                       "linear.app", "asana.com", "sentry.io", "heroku.com", "supabase.com", "cloudflare.com"]),
    calendar: new Set(["zoom.us", "calendly.com", "eventbrite.com", "webex.com", "lu.ma"]),
    newsletterPlatforms: new Set(["substack.com", "beehiiv.com", "medium.com", "mailchimp.com", "convertkit.com",
                                  "buttondown.email", "tldrnewsletter.com", "morningbrew.com", "producthunt.com"]),
};

// Role of the local part (before the @)
const ROLE = {
    marketing:  /^(offers?|deals?|promo(tion)?s?|marketing|store-?news|campaigns?|mailer|rewards?|shop)\b/,
    newsletter: /^(newsletter|news|digest|crew|weekly|daily|editor|bulletin|roundup)\b/,
    order:      /^(orders?|order-?(update|status)|shipment(-?tracking)?|shipping|delivery|tracking|booking|tickets?|ticketadmin|reservations?)\b/,
    billing:    /^(billing|invoices?|receipts?|payments?|statements?|credit_?cards?|accounts?-?payable)\b/,
    security:   /^(security|account-?security|account-?update|verify|auth|password|signin|login|identity)\b/,
    career:     /^(careers?|jobs?|jobalerts?|recruit(ment|er|ing)?|talent|hr|hiring)\b/,
    calendar:   /^(calendar|calendar-?notification|invites?|events?)\b/,
    notify:     /^(notifications?|notify|alerts?)\b/,
    social:     /^(friend-?suggestion|invitations?|groupupdates|notification)\b/,
};

// ═════════════════════════════════════════════════════════════════════════════
// Evidence rules (text based)
//   R(category, family, points, where, regex, reason[, when])
//   family: evidence of the same family counts once per category (max, not sum)
//   where : "subject" | "snippet" | "both"   (each is tested separately)
// ═════════════════════════════════════════════════════════════════════════════
const R = (cat, family, pts, where, re, reason, when) => ({ cat, family, pts, where, re, reason, when });

const RULES = [
    // ── Social ────────────────────────────────────────────────────────────────
    R("Social Update", "structure", 55, "subject", /\b\d+\s+(new\s+)?notifications?\s+(about|from)\b/i,
      "Social-network notification summary"),
    R("Social Update", "structure", 55, "both",
      /\b(friend|group|page|connection|people)\s+suggestions?\b|\bpeople you may know\b/i, "Friend/group suggestion"),
    R("Social Update", "structure", 55, "both",
      /\bwants? to connect\b|\binvited you to connect\b|\baccepted your (invitation|connection|friend|follow)/i, "Connection request"),
    R("Social Update", "structure", 50, "both", /\b(tagged you|mentioned you in (a|an|the) (post|photo|story|comment))\b/i, "You were tagged/mentioned"),
    R("Social Update", "structure", 55, "both",
      /\b(commented on|replied to|reacted to|liked|shared)\s+your\s+(post|photo|comment|story|reel|video|thread|tweet|picture)\b/i,
      "Activity on your post"),
    R("Social Update", "structure", 55, "both", /\b(started following you|followed you|new followers?)\b/i, "New follower"),
    R("Social Update", "structure", 55, "both",
      /\bappeared in \d+ (searches|search results)\b|\bviewed your profile\b|\b\d+ people viewed\b/i, "Profile-view notification"),
    R("Social Update", "structure", 35, "both", /\bunread messages? in\b/i, "Unread community messages"),

    // ── Newsletter ────────────────────────────────────────────────────────────
    R("Newsletter", "structure", 45, "both",
      /\b(newsletter|digest|roundup|recap|issue\s*#?\s*\d+|vol(ume|\.)?\s*\d+|edition|this week in|top stories|headlines|(weekly|daily|monthly)\s+(brief|update|summary))\b/i,
      "Editorial/newsletter format"),
    R("Newsletter", "structure", 45, "both",
      /\b(what['’]s new|release notes|changelog|product updates?|we shipped|what we shipped)\b|\bupdate\s*[:\-–—]/i,
      "Product update / release notes"),
    R("Newsletter", "content", 40, "both",
      /\b\d+\s+(ways|tips|tricks|things|steps|reasons|mistakes|lessons|ideas|habits)\b|\bhow to\b|\b(tips|tricks|guide|inspiration|playbook|case study|best practices)\b|what people are building/i,
      "Educational/content marketing"),
    R("Newsletter", "content", 35, "both", /\b(picked|curated|selected|recommended)\s+for you\b|\bfor you today\b/i, "Curated content"),

    // ── Promotion ─────────────────────────────────────────────────────────────
    R("Promotion", "price", 50, "both",
      /\b(up\s?to\s+)?\d{1,3}\s?%\s?(off|discount|cashback)\b|\bflat\s+(₹|rs\.?|inr|\$)?\s?\d+|(₹|rs\.?|\$)\s?\d[\d,]*\s*(off|cashback)\b|\bcash\s?back\b|\b(coupon|promo code|voucher|use code|discount code)\b|\bfree (delivery|shipping)\b|\bsave\s+(up\s?to\s+)?(\d+|big|extra)/i,
      "Discount / cashback / coupon"),
    R("Promotion", "sale", 40, "both",
      /\b(flash|big|mega|summer|winter|festive|weekend|holiday|end[- ]of[- ]season)\s+(sale|deals?)\b|\bsale\b(?=\s*[:!\-–—]|\s+(ends|is live|starts))|\bon sale\b|\bclearance\b|\bblack friday\b|\bcyber monday\b|\bsavings\b/i,
      "Sale event"),
    R("Promotion", "sale", 35, "both", /\bdeals?\b(?!\s+with)|\bdiscounts?\b/i, "Deal / discount wording"),
    R("Promotion", "sale", 30, "both", /\boffers?\b(?!\s+letter)/i, "Offer wording"),
    R("Promotion", "urgency", 30, "both",
      /\b(last chance|ends?\s+(tonight|today|tomorrow|soon|sunday|midnight|in \d+)|hurry|don['’]t miss( out)?|limited[- ](time|stock|period)|selling fast|before (they['’]re|it['’]s|it|this|the offer) (gone|ends|over|expires)|(few|last) (hours|days) left|today only|act now|while (stocks?|supplies) last|sell out|(offer|sale|deal|trial|membership|plan|subscription)\s+(ends|expires|valid)|expires? soon|expires? in \d+ days?)\b/i,
      "Time-pressure wording"),
    R("Promotion", "cta", 25, "both",
      /\b(shop (now|the|today)|buy now|grab (yours|your|now|it)|order now|upgrade (to|now|today)|claim (your|now|it)|get (yours|started|it now)|start your free|redeem|activate your free|unlock (premium|pro|more|your)|enrol(l)?( now| in)?|register now|book now)\b/i,
      "Call-to-action to buy/upgrade"),
    R("Promotion", "free", 25, "both",
      /\bfree (live )?(trial|subscription|plan|credits?|gift|demo|access|months?|resources|upgrade|session|webinar|class|consultation)\b|\b\d+[- ]months?( of)? free\b|\bno (credit )?card (needed|required)\b|\bwon a free\b/i,
      "'Free' offer"),
    R("Promotion", "cart", 50, "both",
      /\b(your cart|items? in your cart|left (something|items?) (behind|in your cart)|back in stock|new arrivals?|price drop|wishlist)\b/i,
      "Retail re-engagement"),
    R("Promotion", "contest", 35, "both",
      /\b(win (a|an|up to|big|prizes?|rewards?|vouchers?)|contest|giveaway|lucky draw|sweepstakes?)\b/i, "Contest / giveaway"),

    // ── Finance ───────────────────────────────────────────────────────────────
    R("Finance", "transaction", 55, "both",
      /\b(debited|credited)\b|\b(a\/c|acct|account)\s*(no\.?\s*)?(x{2,}|\*{2,})?\d{3,}|\b(upi|imps|neft|rtgs)\b|\b(transaction|txn)\s*(id|ref|no|number)\b|\bbank ref\b|\bavailable balance\b|\bavl\.?\s?bal\b|\btransaction alert\b|\b(spent|withdrawn)\s+(on|at|from|using)\b.{0,30}\b(card|a\/c|account)\b/i,
      "Bank / UPI transaction"),
    R("Finance", "billing", 45, "both",
      /\b(invoice|receipt)\b|\bstatement\b.{0,25}\b(ready|available|generated)\b|\b(credit|debit) card statement\b|\b(bill|premium|emi|installment)\b.{0,30}\b(due|overdue|generated)\b|\bpayment\s+(due|received|successful|confirmed|failed|declined|reminder)\b|\bamount due\b|\bpayment of\b|\b(next billing date|renews? on|auto-?renew(al)?|subscription renews?)\b|\bupdate (your )?payment (method|details|information)\b|\bcouldn['’]t (charge|process)\b/i,
      "Invoice / receipt / billing notice"),
    R("Finance", "invest", 40, "both", /\b(sip|mutual fund|nav|units? allotted|portfolio|dividend|folio|demat)\b/i, "Investment activity"),
    R("Finance", "invest", 35, "both", /\bcredit score\b|\bcibil\b/i, "Credit score"),

    // ── Order Update ──────────────────────────────────────────────────────────
    R("Order Update", "structure", 55, "both",
      /\byour\s+(\w+\s+){0,2}order\b.{0,40}\b(has|have|is|was|will|confirmed|shipped|delivered|placed|dispatched|out for|on the way|arriv)|\border\s*(#|no\.?|id|number)\s*[:\-]?\s*[\w-]{4,}|\border\s+(confirmed|placed|dispatched|shipped|delivered|received|cancel+ed|is on the way)\b|\b(has|have)\s+(been\s+)?(shipped|dispatched|delivered)\b|\bout for delivery\b|\bdelivered:|\bwas delivered\b|\barriving (today|tomorrow|on|by)\b|\btrack your (package|shipment|order|parcel)\b|\b(tracking (number|id)|awb)\b|\bdelivery executive\b|\bestimated delivery\b|\byour (package|parcel|shipment)\b|\b(return|refund|replacement|exchange)\s+(request|initiated|processed|approved|received|completed)\b|\b(booking|reservation|tickets?|e-?tickets?)\s+(is\s+|has been\s+)?(confirmed|cancel+ed)\b|\bpnr\b|\bboarding pass\b|\be-?ticket\b/i,
      "Order / delivery / booking status"),

    // ── Security Alert ────────────────────────────────────────────────────────
    R("Security Alert", "structure", 55, "both",
      /\b(security alert|critical security alert|new sign-?in|sign-?in (attempt|from|to)|new login|login (attempt|from|to|alert)|password (was |has been )?(changed|reset)|reset your password|two-?factor|2-?step( verification)?|2fa|multi-?factor|recovery (email|phone|info)|account (was )?recovered|account recovery|security checkup|security settings|strengthen the security|suspicious (sign-?in|activity|login)|new device|device (signed|authorized)|unusual (sign-?in|activity)|security notice|was this you|verify it['’]s you)\b/i,
      "Account security event"),

    // ── Recruiter ─────────────────────────────────────────────────────────────
    R("Recruiter", "structure", 55, "both",
      /\bjobs?\s+(similar|alert|for you|matching|recommended|opening|opportunit)|\b\d*\s*new jobs?\b|\bjob (alert|opportunity|opening|offer|description)\b|\bopportunity\s*[:\-]|\bopportunity (at|for|with)\b|\bwe(['’]re| are) hiring\b|\bnow hiring\b|\bhiring for\b|\bopen (position|role)\b|\bexciting role\b|\bcareer opportunit|\binternships?\b|\byour application (to|for|was|has been|at)\b|\binterview (invitation|schedule|slot|confirmation|round)|\bshortlisted\b|\boffer letter\b|\bjoining (date|formalities)\b|\b(ctc|lpa|per annum|stipend)\b|\brecruit(er|ment|ing)\b|\btalent acquisition\b/i,
      "Job / recruiting content"),
    R("Recruiter", "outreach", 45, "both",
      /\b(came across|saw|found|reviewed) your (profile|resume|cv|linkedin)\b|\byour (resume|cv)\b|\b(great|good) fit for (this|the|our)\b|\bare you (open|interested) (to|in)\b|\bshare (your|the) (resume|cv|updated)/i,
      "Recruiter outreach wording"),
    R("Recruiter", "apply", 40, "both",
      /\b(apply|applications?)\b.{0,40}\b(jobs?|role|position|internship|opening)s?\b|\b(jobs?|role|position|internship|opening)s?\b.{0,40}\bapply\b/i,
      "Apply-for-job wording"),

    // ── Meeting / Event ───────────────────────────────────────────────────────
    R("Meeting / Event", "invite", 55, "subject",
      /^\s*(updated |new |canceled |cancelled )?invitation\s*:|^\s*(accepted|declined|tentatively accepted)\s*:/i, "Calendar invitation"),
    R("Meeting / Event", "invite", 55, "both",
      /\bcalendar invite\b|\badd to calendar\b|\byour meeting (starts|is|has)\b|\bmeeting (reminder|starts|invite|link|id)\b|\bjoin (zoom|google meet|the meeting|teams|with google meet)\b|\b(zoom|google meet|teams) meeting\b|\bstandup\b|\bsync (at|@|tomorrow|today)\b|\bevent (reminder|scheduled|confirmed)\b|\bnew event\b|\byou(['’]re| are) registered\b|\brsvp\b|\bappointment (reminder|confirmed|scheduled)\b|\bhas been scheduled\b|\btime of this event has changed\b/i,
      "Meeting / event details"),
    R("Meeting / Event", "webinar", 35, "both", /\b(webinar|live session|workshop|conference|summit)\b/i, "Webinar / event"),

    // ── Notification (automated product/system mail) ──────────────────────────
    R("Notification", "structure", 45, "both",
      /\b(pull request|merged|commit(ted)?|build (succeeded|failed|passed)|deployment|deployed|pipeline|issue #?\d+|commented on|mentioned you in|assigned (you|to you)|invited you to|you(['’]ve| have) been (added|invited)|recording (is )?(now )?(ready|available)|scheduled maintenance|maintenance (window|on)|service (disruption|outage|update)|incident|your (export|report|download|file|data) is ready|unread messages?|new (comment|reply|message) (on|from|in)|registration complete|account (is )?ready|welcome to|confirm your email|verify your email( address)?|activate your account|exam (schedule|update)|admit card)\b/i,
      "Automated product/system notification"),

    // ── Important (personal / first-party account & policy notices) ───────────
    R("Important", "personal", 60, "subject", /^\s*(re|fwd?|fw)\s*:/i, "Looks like a personal reply/forward",
      ctx => !ctx.isBulk),
    R("Important", "discussed", 40, "both",
      /\b(as discussed|we discussed|per our (call|conversation)|as per our|following up on our)\b/i, "Refers to a prior conversation",
      ctx => !ctx.isBulk),
    R("Important", "policy", 45, "subject",
      /\b(terms( of (use|service))?|privacy( policy| settings| controls| notice| update)?|policy (update|change)s?)\b/i,
      "Account / policy notice", ctx => !ctx.isBulk),
];

// ═════════════════════════════════════════════════════════════════════════════
// Evidence collection
// ═════════════════════════════════════════════════════════════════════════════
function buildContext(subject, from, snippet, headers) {
    const sender = parseSender(from);
    const subj   = (subject || "").replace(/[’‘]/g, "'");
    const snip   = (snippet || "").replace(/[’‘]/g, "'");
    const h      = headers || {};
    const hasListUnsub   = !!h["List-Unsubscribe"];
    const precedenceBulk = ["bulk", "list"].includes(String(h["Precedence"] || "").toLowerCase());
    const unsubText      = /\b(unsubscribe|opt.?out|manage (your )?(email )?preferences)\b/i.test(snip);
    return {
        subject: subj, snippet: snip, sender,
        isBulk: hasListUnsub || precedenceBulk || unsubText,
        hasListUnsub,
        isFreemail: FREEMAIL.has(sender.root),
        isSuspiciousTld: SUSPICIOUS_TLDS.has(sender.tld),
    };
}

function textEvidence(ctx) {
    const out = [];
    for (const rule of RULES) {
        if (rule.when && !rule.when(ctx)) continue;
        let pts = 0;
        if (rule.where !== "snippet" && rule.re.test(ctx.subject)) pts = rule.pts;
        if (rule.where !== "subject" && rule.re.test(ctx.snippet)) pts = Math.max(pts, rule.pts * SNIPPET_FACTOR);
        if (pts > 0) out.push({ cat: rule.cat, family: rule.family, pts, reason: rule.reason });
    }

    // OTP / verification code: needs BOTH a code phrase and an actual number.
    const text = `${ctx.subject} ${ctx.snippet}`;
    const codePhrase = /\b(otp|one[- ]time (password|passcode|pin)|verification code|security code|authentication code|login code|sign-?in code|confirmation code)\b/i;
    if (codePhrase.test(text)) {
        const hasDigits = /\b\d{4,8}\b/.test(text);
        out.push({ cat: "OTP / Auth", family: "structure", pts: hasDigits ? 70 : 40,
                   reason: hasDigits ? "One-time code with digits" : "Mentions a verification code" });
    }
    return out;
}

function senderEvidence(ctx) {
    const { sender } = ctx;
    const out = [];
    const add = (cat, family, pts, reason) => out.push({ cat, family, pts, reason });

    // Sender-domain priors
    if (DOMAINS.social.has(sender.root))   add("Social Update", "sender-domain", 30, `Sent by a social platform (${sender.root})`);
    if (DOMAINS.jobs.has(sender.root))     add("Recruiter",     "sender-domain", 30, `Sent by a job platform (${sender.root})`);
    if (DOMAINS.finance.has(sender.root) || /bank\./.test(sender.root))
        add("Finance", "sender-domain", 25, `Sent by a bank/payments provider (${sender.root})`);
    if (DOMAINS.commerce.has(sender.root)) add("Order Update",  "sender-domain", 15, `Sent by a retailer (${sender.root})`);
    if (DOMAINS.devtools.has(sender.root)) add("Notification",  "sender-domain", 30, `Sent by a productivity/dev tool (${sender.root})`);
    if (DOMAINS.calendar.has(sender.root)) add("Meeting / Event", "sender-domain", 30, `Sent by a meeting/event service (${sender.root})`);
    if (DOMAINS.newsletterPlatforms.has(sender.root) || /(newsletter|digest|weekly|bulletin|roundup)/.test(sender.root))
        add("Newsletter", "sender-domain", 30, `Sent by a newsletter source (${sender.root})`);
    // First-party identity providers send account/security mail
    if (OFFICIAL_DOMAINS.has(sender.root) && /^(accounts?|accountprotection|security|id|login)\b/.test(sender.host))
        add("Security Alert", "sender-domain", 20, "Sent from the provider's account/security system");

    // Local-part roles
    const l = sender.local;
    if (ROLE.marketing.test(l))  add("Promotion",       "sender-role", 20, "Marketing-style sender address");
    if (ROLE.newsletter.test(l)) add("Newsletter",      "sender-role", 25, "Newsletter-style sender address");
    if (ROLE.order.test(l))      add("Order Update",    "sender-role", 25, "Orders/booking sender address");
    if (ROLE.billing.test(l))    add("Finance",         "sender-role", 15, "Billing sender address");
    if (ROLE.security.test(l))   add("Security Alert",  "sender-role", 20, "Security/account sender address");
    if (ROLE.career.test(l))     add("Recruiter",       "sender-role", 25, "Careers/HR sender address");
    if (ROLE.calendar.test(l))   add("Meeting / Event", "sender-role", 35, "Calendar sender address");
    if (ROLE.notify.test(l) && DOMAINS.devtools.has(sender.root))
        add("Notification", "sender-role", 25, "Automated notification address");
    if (ROLE.social.test(l) && DOMAINS.social.has(sender.root))
        add("Social Update", "sender-role", 15, "Social notification address");
    return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Aggregation
// ═════════════════════════════════════════════════════════════════════════════
function aggregate(evidence, ctx) {
    const cats = {};
    for (const e of evidence) {
        const c = (cats[e.cat] ||= { families: {} });
        const cur = c.families[e.family];
        if (!cur || e.pts > cur.pts) c.families[e.family] = e;
    }

    const result = {};
    const personal = ctx.isFreemail && !ctx.isBulk;
    for (const [cat, c] of Object.entries(cats)) {
        const items = Object.values(c.families);
        let score = items.reduce((s, e) => s + e.pts, 0);

        // Bulk header corroborates (never creates) mass-mail categories
        if (ctx.isBulk && ["Newsletter", "Promotion", "Social Update"].includes(cat)) {
            const bonus = score >= 30 ? BULK_CORROBORATION : BULK_WEAK;
            score += bonus;
            items.push({ cat, family: "header", pts: bonus, reason: "Bulk-mail header (unsubscribe/precedence)" });
        }
        // Personal address, not bulk: topical keywords are weaker evidence
        if (personal && cat !== "Important") score *= PERSONAL_DAMPEN;

        result[cat] = { score: Math.min(100, Math.round(score)), items };
    }
    return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// Phishing: requires DECEPTION evidence, not alarming words
// ═════════════════════════════════════════════════════════════════════════════
const LEET = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "@": "a", "$": "s" };

function claimedBrands(ctx) {
    const { sender } = ctx;
    const claimText = `${sender.name} ${sender.local} ${sender.root.split(".")[0]}`;
    const normalised = claimText.replace(/[01345@$]/g, ch => LEET[ch]);
    return BRANDS.filter(([, re]) => re.test(claimText) || re.test(normalised));
}

function assessPhishing(ctx) {
    const { sender } = ctx;
    const text = `${ctx.subject} ${ctx.snippet}`;
    let score = 0, deception = false;
    const reasons = [];
    const add = (pts, reason, isDeception = false) => { score += pts; reasons.push(reason); if (isDeception) deception = true; };

    const claimed = claimedBrands(ctx);
    const fromOfficial = OFFICIAL_DOMAINS.has(sender.root);
    const fromKnownService = fromOfficial || Object.values(DOMAINS).some(set => set.has(sender.root));

    // 1. Brand impersonation: claims a brand but isn't on its official domain AND looks forged
    for (const [brand, , official] of claimed) {
        if (official.includes(sender.root)) continue;
        const lookalike = /[-]/.test(sender.root) || /\d/.test(sender.root.split(".")[0]);
        if (ctx.isSuspiciousTld || lookalike || ctx.isFreemail) {
            add(45, `Sender impersonates ${brand} (not from ${official[0]})`, true);
            break;
        }
    }
    // 2. Abuse-prone TLD on the sender domain
    if (ctx.isSuspiciousTld) add(25, `Sender domain uses a high-abuse extension (.${sender.tld})`, true);
    // 3. Lookalike words in a hyphenated domain (secure-login.com, hdfc-secure-update.in)
    if (/-/.test(sender.root) && /(secur|verif|login|signin|updat|kyc|alert|support|helpdesk|billing)/.test(sender.root))
        add(15, "Sender domain looks like a lookalike (hyphenated security words)", true);
    // 4. URL shorteners / links to abuse TLDs in the visible text
    if (/\b(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|t\.co|rb\.gy|cutt\.ly|is\.gd)\//i.test(text))
        add(20, "Shortened/redirecting link", true);
    if (new RegExp(`https?://[^\\s]+\\.(${[...SUSPICIOUS_TLDS].join("|")})(/|\\s|$)`, "i").test(text))
        add(20, "Link to a high-abuse domain", true);
    // 5. Credential / payment lure
    const lure = /\b(verify|confirm|validate|update|restore|re-?activate|unlock)\W+(your\W+)?(apple id|account|identity|password|payment( details| method| information)?|billing( information| info)?|bank|kyc|pan|card|login|credentials|netbanking)\b|\b(kyc|pan)\W+(update|verification|expired)\b/i.test(text);
    if (lure) add(20, "Asks you to verify/update credentials or payment details");
    // 6. Threat / urgency
    const threat = /\b(will be|has been|is being|been)\s+(suspended|blocked|locked|closed|cancel+ed|terminated|deactivated|limited)\b|\bwithin\s+\d+\s+(hours?|hrs?)\b|\bfinal notice\b|\blast warning\b|\bexpires today\b|\baccess (will be )?(restricted|limited)\b|\baccount (is )?(blocked|locked|suspended)\b|\bimmediately\b/i.test(text);
    if (threat) add(15, "Threat/urgency pressure");
    if (lure && threat) add(10, "Credential request combined with a threat");
    // 7. Prize / gift lure — much weaker if it comes with a real unsubscribe header
    if (/\b(you(?:'ve| have)? (?:won|been selected)|lucky winner|claim your (prize|reward|gift)|free (iphone|ipad|laptop)|gift card|lottery)\b/i.test(text))
        add(ctx.hasListUnsub ? 15 : 30, "Prize / gift-card lure");
    // 8. Delivery-fee scam
    if (/\b(customs fee|reschedule delivery|package (couldn'?t|could not) be delivered|redelivery fee|(package|parcel|shipment) (is |has been )?on hold)\b|\b(pay|small|handling|clearance)\b.{0,25}\b(fee|charge)\b.{0,40}\b(release|deliver|package|parcel)/i.test(text))
        add(20, "Delivery-fee scam wording");

    // Mail that genuinely comes from the brand's own domain / a known service is not phishing
    if (fromOfficial) { score = Math.max(0, score - 45); }
    else if (fromKnownService) { score = Math.max(0, score - 20); }

    const flagged = deception && score >= PHISH_MIN_SCORE;
    return { score: Math.min(100, score), deception, flagged, reasons };
}

// ═════════════════════════════════════════════════════════════════════════════
// Decision
// ═════════════════════════════════════════════════════════════════════════════
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function rankCategories(scored) {
    return Object.entries(scored)
        .map(([cat, v]) => ({ cat, score: v.score, items: v.items }))
        .sort((a, b) => b.score - a.score || TIE_BREAK.indexOf(a.cat) - TIE_BREAK.indexOf(b.cat));
}

function scoreEmail(subject, sender, bodySnippet = "", headers = {}) {
    const ctx = buildContext(subject, sender, bodySnippet, headers);
    const phishing = assessPhishing(ctx);
    const evidence = [...textEvidence(ctx), ...senderEvidence(ctx)];
    const scored   = aggregate(evidence, ctx);
    const ranked   = rankCategories(scored);
    const top      = ranked[0];
    const second   = ranked[1];

    const scoresView = Object.fromEntries(ranked.map(r => [r.cat, r.score]));
    let category, confidence, reasons;

    if (phishing.flagged) {
        category   = "Phishing Risk";
        confidence = clamp(Math.round(55 + phishing.score * 0.5), 55, 98);
        reasons    = phishing.reasons;
    } else if (top && top.score >= CATEGORY_MIN_SCORE) {
        category   = top.cat;
        const margin = top.score - (second ? second.score : 0);
        confidence = clamp(Math.round(30 + 0.5 * top.score + 0.3 * margin), 30, 98);
        reasons    = [...top.items].sort((a, b) => b.pts - a.pts).map(e => e.reason).slice(0, 4);
    } else {
        category   = "Uncategorized";
        confidence = 50;
        reasons    = top
            ? [`No category reached the confidence threshold (closest: ${top.cat}, ${top.score}/${CATEGORY_MIN_SCORE}) — left in inbox`]
            : ["No recognisable signals — treated as normal mail and left in inbox"];
    }

    if (!reasons.length) reasons = ["Classified from sender and subject signals"];

    // Auto-archive only archivable categories AND only when confident ("when in doubt, don't")
    const archive = REMOVE_FROM_INBOX.has(category) && confidence >= ARCHIVE_MIN_CONFIDENCE;

    // v2-compatible `signals`: every evidence family that fired, keyed by category
    const signals = {};
    for (const r of ranked) for (const it of r.items) signals[`${r.cat}:${it.family}`] = true;

    return {
        category,
        label:      LABEL_FOR_CATEGORY[category] || "AI/Uncategorized",
        score:      top ? top.score : 0,
        confidence,
        archive,
        reasons,
        signals,
        scores:     scoresView,
        phishing:   { score: phishing.score, deception: phishing.deception, flagged: phishing.flagged },
    };
}

function batchScore(emails) {
    return emails.map(e => {
        const result = scoreEmail(e.subject || "", e.from || "", e.snippet || "", e.headers || {});
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

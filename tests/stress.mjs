/**
 * STRESS SET — adversarial cases written AFTER the v3 scorer and the first
 * holdout run, specifically to break it:
 *   - senders/brands NOT in the scorer's registries
 *   - empty or very thin snippets
 *   - scary-but-legitimate mail, and phishing without the obvious tells
 *   - personal mail that contains promo vocabulary
 *
 * First-pass results on this set are recorded in the report BEFORE any
 * follow-up fix. After fixes it is no longer independent — see README.
 */
const mk = (id, group, from, subject, snippet, flags, expected, accept = []) => ({
  id, group, from, subject, snippet,
  headers: {
    "List-Unsubscribe": flags.includes("L") ? "<mailto:unsubscribe@example.com>" : "",
    "Precedence":       flags.includes("B") ? "bulk" : "",
  },
  expected, accept,
});

export const STRESS = [
  // ── Promotions from unknown brands ───────────────────────────────────────
  mk("s-promo-01", "promotion", "Bella Rugs <hello@bellarugs.co>",
     "Spring clearance - rugs from $49", "Free shipping on all orders this week only.", "L", "Promotion"),
  mk("s-promo-02", "promotion", "FitPulse <news@fitpulse.app>",
     "Your 7-day trial is almost over - don't lose your progress", "Subscribe now to keep tracking your workouts.", "L", "Promotion", ["Notification"]),
  mk("s-promo-03", "promotion", "SkyFinder <deals@skyfinder.com>",
     "Flights to Goa from ₹3,499", "Prices go up soon. Book now.", "L", "Promotion"),
  mk("s-promo-04", "promotion", "BookNest <hello@booknest.in>",
     "A little something for you 🎁", "Use code READ15 at checkout for 15% off your next book.", "L", "Promotion"),
  mk("s-promo-05", "promotion", "Mega Mobile <info@megamobile.in>",
     "iPhone 15 at the lowest price ever", "", "L", "Promotion", ["Uncategorized"]),
  mk("s-promo-06", "promotion", "Coursera <no-reply@t.mail.coursera.org>",
     "Learn Python - 7 courses on sale", "Sale ends in 2 days. Save up to 40% on certificates.", "L", "Promotion"),
  mk("s-promo-07", "promotion", "Raj Electronics <rajelectronics@gmail.com>",
     "Diwali bumper offer!!!", "Flat 30% off on all TVs. Visit our store.", "", "Promotion", ["Uncategorized"]),
  mk("s-promo-08", "promotion", "ICICI Bank <offers@icicibank.com>",
     "Get ₹1000 cashback on your credit card", "Spend ₹10,000 this month and earn cashback. T&C apply.", "L", "Promotion"),

  // ── Newsletters from unknown sources ─────────────────────────────────────
  mk("s-news-01", "newsletter", "Stratechery <email@stratechery.com>",
     "The Vision Pro is a developer play", "This week's Update: platforms, developers and the next computing shift.", "L", "Newsletter"),
  mk("s-news-02", "newsletter", "Hacker Newsletter <kale@hackernewsletter.com>",
     "#712", "Curated top links from Hacker News this week.", "L", "Newsletter"),
  mk("s-news-03", "newsletter", "DEV <yo@dev.to>",
     "Weekly digest: 5 posts you may like", "Top posts from the community this week.", "L", "Newsletter"),
  mk("s-news-04", "newsletter", "Anya's Notes <anya@anyawrites.com>",
     "On slow mornings", "A short essay on routines, plus what I've been reading lately.", "L", "Newsletter", ["Uncategorized"]),
  mk("s-news-05", "newsletter", "GitHub <noreply@github.com>",
     "Your weekly GitHub digest", "Here's what happened in your repositories this week.", "L", "Newsletter", ["Notification"]),

  // ── Social on thinner evidence ───────────────────────────────────────────
  mk("s-soc-01", "social", "Snapchat <no-reply@accounts.snapchat.com>",
     "Ankit sent you a Snap", "Open Snapchat to view.", "L", "Social Update", ["Notification", "Uncategorized"]),
  mk("s-soc-02", "social", "Pinterest <pinbot@explore.pinterest.com>",
     "New pins picked for you", "Ideas for your Home board and more.", "L", "Social Update", ["Newsletter"]),
  mk("s-soc-03", "social", "Meetup <info@meetup.com>",
     "Events near you this week", "RSVP to events from the groups you joined.", "L", "Meeting / Event", ["Social Update", "Newsletter", "Promotion"]),
  mk("s-soc-04", "social", "Threads <no-reply@threads.net>",
     "Maya replied to your post", "Maya: Totally agree with this.", "L", "Social Update"),
  mk("s-soc-05", "social", "YouTube <no-reply@youtube.com>",
     "New comment on your video", "Raj: great explanation!", "L", "Social Update", ["Notification"]),

  // ── Finance with thin evidence ───────────────────────────────────────────
  mk("s-fin-01", "finance", "Axis Bank <alerts@axisbank.com>",
     "Transaction alert: INR 2,300 spent on card XX1234", "Avl Bal INR 15,000.", "", "Finance"),
  mk("s-fin-02", "finance", "Kotak <statements@kotak.com>",
     "Your e-statement for May", "Please find your account statement attached.", "", "Finance"),
  mk("s-fin-03", "finance", "Wise <noreply@wise.com>",
     "Your transfer to Ananya is on its way", "We've received your money and sent ₹10,000.", "", "Finance", ["Notification", "Uncategorized"]),
  mk("s-fin-04", "finance", "Zerodha <no-reply@zerodha.com>",
     "Contract note for 12-Jun", "Your contract note is attached.", "", "Finance", ["Uncategorized"]),
  mk("s-fin-05", "finance", "Airtel <noreply@airtel.in>",
     "Your bill for 9876543210 is generated", "Pay ₹499 by 20 June to avoid late fee.", "", "Finance"),
  mk("s-fin-06", "finance", "Uber <uber.india@uber.com>",
     "Your Friday evening trip with Uber", "Total ₹212. Thanks for riding, Fb.", "", "Finance", ["Order Update", "Notification", "Uncategorized"]),

  // ── Orders with thin evidence ────────────────────────────────────────────
  mk("s-ord-01", "orders", "Decathlon <noreply@decathlon.in>",
     "Your parcel is on the way", "Track it with AWB 1234567.", "", "Order Update"),
  mk("s-ord-02", "orders", "Domino's <orders@dominos.co.in>",
     "Order #A8821 confirmed", "Your pizza is being prepared.", "", "Order Update"),
  mk("s-ord-03", "orders", "Meesho <noreply@meesho.com>",
     "Your Meesho package is delayed", "We're sorry - your package will now arrive on 24 June.", "", "Order Update", ["Notification"]),

  // ── Recruiter / career ───────────────────────────────────────────────────
  mk("s-rec-01", "recruiter", "Priya from Deloitte <priya.s@deloitte.com>",
     "Quick chat about a role?", "Hi, I'm a recruiter at Deloitte. Would love to connect.", "", "Recruiter"),
  mk("s-rec-02", "recruiter", "Wellfound <jobs@wellfound.com>",
     "Startups hiring ML engineers", "Matched to your profile and preferences.", "L", "Recruiter"),
  mk("s-rec-03", "recruiter", "Google Careers <noreply@google.com>",
     "Update on your application", "Thank you for interviewing with us. We have an update for you.", "", "Recruiter", ["Important", "Uncategorized"]),
  mk("s-rec-04", "recruiter", "VIT Admissions <admissions@vit.ac.in>",
     "Last date to apply: B.Tech 2026", "Applications close on 30 June. Apply online today.", "L", "Promotion", ["Uncategorized", "Important"]),
  mk("s-rec-05", "recruiter", "HR <hr@nbkrist.org>",
     "Placement drive: TCS on 20 June", "Eligible students should register by 18 June.", "", "Recruiter", ["Important", "Uncategorized"]),

  // ── Meetings ─────────────────────────────────────────────────────────────
  mk("s-meet-01", "meeting", "Priya <priya@acme.in>",
     "Can we meet tomorrow at 4?", "Need 15 mins on the report.", "", "Uncategorized", ["Meeting / Event", "Important"]),
  mk("s-meet-02", "meeting", "Microsoft Teams <noreply@email.teams.microsoft.com>",
     "Meeting invitation: Weekly sync", "Join the Teams meeting on Friday at 10:00.", "", "Meeting / Event"),
  mk("s-meet-03", "meeting", "Dr. Mehta <drmehta.clinic@gmail.com>",
     "Appointment reminder: Thursday 5pm", "Your appointment is confirmed. Please arrive 10 minutes early.", "", "Meeting / Event", ["Uncategorized", "Important"]),

  // ── Phishing without the obvious tells ───────────────────────────────────
  mk("s-ph-01", "phishing", "DHL Express <noreply@dhl-parcel-tracking.com>",
     "Your parcel is on hold", "Pay a small fee to release your package: http://dhl-parcel-tracking.com/pay", "", "Phishing Risk", ["Order Update"]),
  mk("s-ph-02", "phishing", "Bank Alert <alert@sbi-onlinebanking.in>",
     "Your YONO account has been suspended", "Click to reactivate: http://sbi-yono-login.top/verify", "", "Phishing Risk"),
  mk("s-ph-03", "phishing", "Accounts Dept <acct.dept.2025@gmail.com>",
     "Invoice #8872 overdue - pay today", "Please see attached invoice and pay immediately to avoid penalty.", "", "Phishing Risk", ["Uncategorized"]),
  mk("s-ph-04", "phishing", "Google Security <security@accounts-google.com.verify-login.top>",
     "Security alert", "A new sign-in to your account. Review activity: bit.ly/gsec", "", "Phishing Risk"),
  mk("s-ph-05", "phishing", "Support Team <support@account-verification.com>",
     "Your mailbox is full - verify now", "Verify your account within 24 hours to avoid suspension.", "", "Phishing Risk"),

  // ── Scary-but-legitimate (must NOT be phishing) ──────────────────────────
  mk("s-legit-01", "legit-scary", "Google Drive <drive-shares-noreply@google.com>",
     "Aarav shared 'Notes' with you", "Aarav has shared a document with you. Open in Docs.", "", "Uncategorized", ["Notification", "Important"]),
  mk("s-legit-02", "legit-scary", "Amazon <no-reply@amazon.in>",
     "Amazon.in password assistance", "Use OTP 482913 to reset your password. Don't share it.", "", "OTP / Auth", ["Security Alert"]),
  mk("s-legit-03", "legit-scary", "HDFC Bank <alerts@hdfcbank.net>",
     "Important: Update your KYC to avoid account restrictions", "Please visit your branch or update KYC at hdfcbank.com within 30 days.", "", "Important", ["Finance", "Uncategorized", "Notification"]),
  mk("s-legit-04", "legit-scary", "Binance <do-not-reply@post.binance.com>",
     "Withdrawal confirmation: verify your account", "Confirm this withdrawal within 24 hours using the link.", "", "Security Alert", ["Finance", "Notification", "Uncategorized"]),
  mk("s-legit-05", "legit-scary", "Zoom <no-reply@zoom.us>",
     "Your password was changed", "The password for your Zoom account was changed. If this wasn't you, reset it now.", "", "Security Alert"),
  mk("s-legit-06", "legit-scary", "LinkedIn <security-noreply@linkedin.com>",
     "Your LinkedIn login verification code", "Code: 553201. Expires in 10 minutes.", "", "OTP / Auth"),

  // ── Personal / edge ──────────────────────────────────────────────────────
  mk("s-norm-01", "normal", "Unknown <x@y.com>", "(no subject)", "", "", "Uncategorized"),
  mk("s-norm-02", "normal", "Mamá <mama@gmail.com>", "Foto de la boda", "Te mando las fotos de ayer. Llámame cuando puedas.", "", "Uncategorized"),
  mk("s-norm-03", "normal", "Karan <karan.s@gmail.com>",
     "Sale at the mall this weekend? 50% off!", "Want to go? Flat 50% off on shoes at the new store.", "", "Uncategorized", ["Promotion"]),
  mk("s-norm-04", "normal", "Raju <raju@startup.io>",
     "Re: Offer discussion", "Let's talk compensation tomorrow.", "", "Important", ["Recruiter"]),
  mk("s-norm-05", "normal", "Meera <meera.k@gmail.com>",
     "Check this out", "You won't believe what happened at college today. Call me!", "", "Uncategorized"),
];

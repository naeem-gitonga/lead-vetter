# Lead Vetter Chrome Extension

> A Chrome extension that automates LinkedIn lead vetting using a local LLM to filter profiles based on custom criteria.

## The Problem

When doing customer discovery, I needed **hot, high-priority leads**—people I should talk to first. Using LinkedIn's search tool, I could export profiles, but the search was too broad ("paralegal") and the filters weren't specific enough. I was left manually clicking through hundreds of profiles to find worthy candidates.

### My Criteria for a "Good" Lead

1. **Current job title** is paralegal, legal assistant, or attorney (and they're currently employed as such)
2. **Recent activity**—post, repost, reaction, or comment within the past month
3. **Company size** of 1–10 employees

## What This Extension Does

1. Pulls a list of LinkedIn users from another software (e.g., HeyReach) via CSV export
2. Fetches each lead's activity, experience, and company information
3. Sends all data to a locally hosted LLM
4. The LLM checks each lead against the three criteria above
5. Returns two CSV files:
   - **Hot Leads** — meets all three criteria
   - **Worth Checking Out** — correct title/company size but no recent activity

## Performance

- Processed **247 leads in under 15 minutes** (when used at short intervals)
- Eliminated hours of manual profile clicking and review

## The Bot Detection Problem

After running for ~36 hours and processing hundreds of profiles, my LinkedIn account got restricted. LinkedIn detected the automation.

### Why LinkedIn Flagged Me

LinkedIn uses **behavioral analytics** to detect bots:

| Technique | What It Catches |
|-----------|-----------------|
| `event.isTrusted` ratio | Synthetic events (JS-dispatched) vs real hardware input |
| Mouse trajectory analysis | Linear/absent movement, no micro-corrections |
| Scroll physics | Uniform velocity, no momentum, wrong deceleration curve |
| Interaction entropy | Too regular = bot; humans have high variance |
| TLS fingerprinting (JA3/JA4) | Identifies client by TLS handshake signature |
| Canvas/WebGL fingerprinting | Device fingerprint consistency across sessions |
| `navigator.webdriver` | True in Selenium/Playwright unless patched |
| Chrome DevTools Protocol (CDP) detection | Exposed runtime properties in automated Chrome |
| Font/plugin enumeration | Headless Chrome has different font sets |
| Request velocity | Too many profile views per hour/day |
| Absence of organic navigation | Only visits profile pages, never feed/search |

My extension had **perfectly timed intervals** between actions and **no mouse events** before scrolling—dead giveaways for bot behavior.

## Can You Beat the Bot Detection?

**Probably.** You'd need hardware that randomly clicks and scrolls with an actual mouse—something I'm not equipped to build as a software engineer.

## Important Notes

- I did **not** read LinkedIn's Terms of Use prior to building this
- This extension **violates LinkedIn's ToS** and will likely result in account suspension
- Use at your own risk—permanent ban is possible
- Built as a proof of concept, not for production/maintenance

## Code Quality

This code is **not cleaned up** for maintainability or scalability—it was built for one-off use.

## Acknowledgments

Thank God for AI powers! 🙏

This demonstrates what's possible with local LLMs for automation tasks. If you're in sales or need to vet many candidates, this shows the power of AI-assisted filtering.

---

**Use responsibly.** Platforms like LinkedIn invest heavily in bot detection for good reason. Consider the ethical and legal implications before deploying automation.

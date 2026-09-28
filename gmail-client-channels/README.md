# Gmail Client Channels – setup guide

Every client gets its own Gmail label (a "channel") in the left sidebar, for example `Clients/ABC Ltd`. Every bank gets one too, for example `Banks/HDFC`. Old mail, new mail, sent mail and Cc'd mail are all covered. Your Inbox is left as it is.

Built for **hemanth@hkjain.com (Google Workspace)** with these choices:

| Decision | Your choice |
|---|---|
| Banks | `Banks/<bank name>`, from an editable bank list. Any `*.bank.in` domain is detected automatically. |
| New client domain | The channel is created automatically, and a daily 8 AM digest e-mail lists new channels for review |
| Group / multi-domain clients | Channel is named after the client, e.g. `Clients/Hyundai Group`, with every domain mapped to it |

---

## 1. Options compared

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Gmail labels + filters (manual)** | No code. Runs instantly as mail arrives. | One filter per client. Max ~1,000 filters. Filters don't match on Cc for sent mail. Can't auto-create channels for new domains. "Apply to existing" only runs once, when the filter is created. | Fine for fewer than 20 clients |
| **Google Apps Script + Google Sheet (this solution)** | Free and runs inside your Google account; no mail leaves Google. Handles domain logic, exclusions, multi-domain and personal-Gmail mapping, auto-creation and the digest. The Sheet is an easy control panel. | Runs every 10 minutes rather than instantly. The first back-fill of a large mailbox takes 1–3 days. Subject to Apps Script quotas. | **Recommended** |
| **Claude + Gmail connector (MCP)** | Ask in plain English, e.g. "label all mail from xyz.co.in as Clients/XYZ". Good for one-off clean-ups and reviewing the digest. | Only works while you are chatting, so nothing runs in the background. The Gmail connector in this session is signed in to **hkjain2014@gmail.com**, not hemanth@hkjain.com. | Use as a helper, not the engine |
| **Custom app (Gmail API + Pub/Sub push, Cloud Run)** | Real-time. No Apps Script quotas. | Needs a Google Cloud project, OAuth consent and hosting, which costs money and needs maintenance. | Overkill for one mailbox |
| **Third-party add-ons (e.g. SaneBox, Clean Email)** | Polished UI | Your client mail is processed by an outside vendor, which is a confidentiality concern under the ICAI Code of Ethics and the DPDP Act 2023. They are not built around per-client domain channels. | Not recommended for a CA practice |

---

## 2. One-time setup (about 15 minutes)

1. Sign in to Chrome as **hemanth@hkjain.com**.
2. Go to **sheets.new** and name the sheet `Client Channels – Control Panel`. Keep it private.
3. In the sheet, open **Extensions → Apps Script**.
4. Delete the sample code and paste all of **`Code.gs`**.
5. Turn on the Gmail API: in the left pane click **Services (+)**, choose **Gmail API** (v1, identifier `Gmail`), then **Add**.
6. Click **Project Settings (⚙)**, tick **"Show appsscript.json manifest file in editor"**, then open `appsscript.json` and replace it with the file in this folder. This sets the time zone to Asia/Kolkata and limits permissions to the minimum needed.
7. Save, then reload the sheet. A new menu called **Client Channels** appears.
8. Click **Client Channels → 1. Set up sheet**. Approve the permission prompt.
   * If your Workspace admin blocks unverified apps, ask them to allow it under Admin console → Security → API controls.
9. Check the **Settings** tab:
   * `OWN_DOMAINS` = `hkjain.com`
   * `DRY_RUN` = **TRUE**. Leave it on for the first pass.
10. Click **Client Channels → 2. Start automation**.

### Dry run: review before anything is labelled
* While `DRY_RUN` is TRUE, the script scans your mail and fills the **DomainMap** tab. **It doesn't touch Gmail.** Check progress with **Show status**.
* When the scan shows **COMPLETE**, review DomainMap:
  * **Type** can be `Client`, `Bank`, `Ignore` (never a channel) or `Review` (not labelled yet).
  * **Channel Name**: give several domains the same name to merge them into one channel. For example, `hyundai.co.kr` and `hyundai.co.in` both become `Hyundai Group`.
  * Rows that look like newsletters or no-reply senders are already marked `Review`.
* In **EmailMap**, add clients who write from personal Gmail: `ravi.k@gmail.com | ABC Ltd`.
* Add anything that should never be a channel to **Exclusions**.
* Set **`DRY_RUN` = FALSE**. The next run labels all old mail in one pass, then keeps new mail up to date every 10 minutes.

### Day to day
* The 8 AM digest e-mail lists new domains. If one is wrong, change its **Type** to `Ignore`, or rename or merge it via **Channel Name**. The next run fixes Gmail automatically: labels are renamed, merged or removed.
* To archive client mail out of the Inbox later, set `ARCHIVE_CLIENT_MAIL` (or `ARCHIVE_BANK_MAIL`) to TRUE.

### How matching works (in priority order)
1. Your own addresses and domains → ignored. This covers your login, your Send-As aliases and `OWN_DOMAINS`.
2. **EmailMap** exact address → that client's channel.
3. **DomainMap**, including subdomains, so `mail.abc.com` matches `abc.com` → Client, Bank or Ignore.
4. **Exclusions**, including subdomains, so `gov.in` covers incometax.gov.in, gst.gov.in, mca.gov.in, etc. → ignored.
5. Unknown `*.bank.in` domain → new `Banks/<name>` channel.
6. Unknown domain:
   * If it looks like bulk mail (List-Unsubscribe header, or a sender such as noreply@, newsletter@ or alerts@) → added as `Review`.
   * Otherwise → a new `Clients/<domain>` channel.
   * A domain you **sent** mail to always counts as a client.

From, To and Cc are all checked on every message, including your sent mail. A thread gets every channel that matches.

---

## 3. Limits to know

| Limit | Value | Impact here |
|---|---|---|
| Gmail labels per account | About 5,000 is widely reported. Google suggests staying below about 500 for performance. | Fine for a typical practice. Merge dormant clients if you get close. |
| Gmail filters | 1,000 per account; about 1,500 characters per filter | Not used by this script |
| Apps Script run time | 6 minutes per execution (same for consumer and Workspace) | The script stops itself at about 2.3 minutes and resumes on the next run |
| Apps Script triggers total runtime | Workspace: 6 hours/day. Consumer Gmail: 90 minutes/day. | A 10-minute schedule × 2.3 minutes stays under 6 hours/day |
| Mail sent by script | Workspace: 1,500 recipients/day | 1 digest per day |
| Gmail API per-user rate | Rate-limited per second (quota units) | Built-in automatic retry with back-off |
| History API | History IDs can expire after a period of inactivity | The script falls back to scanning the last 10 days |

Rough speed: **about 2,500–3,000 threads per hour**, or about 60,000 per day, during the first back-fill. This is an estimate: about 0.3 s per thread and 140 s of work per 10-minute run. A mailbox with 100,000 threads takes about 2 days.

To limit the back-fill, set `BACKFILL_QUERY`, e.g. `after:2020/04/01`.

---

## 4. Undo and clean-up

| Situation | What to do |
|---|---|
| Stop everything | Menu → **Pause automation**. Labels already applied stay. |
| A channel is wrong | Set its Type to `Ignore` in DomainMap. The label is removed on the next run. **E-mails are never deleted.** |
| Merge two channels | Give both rows the same Channel Name. Threads are moved and the old label is removed. |
| Archived mail should come back | Menu → **UNDO: put auto-archived mail back in Inbox**. Only threads the script archived are touched, via a hidden marker label. |
| Start again from scratch | Menu → **UNDO: delete all channel labels**. This deletes every `Clients/…` and `Banks/…` label and pauses automation. Your mail stays in Inbox and All Mail. |
| Remove the script completely | Pause automation, then revoke access at **myaccount.google.com → Security → Third-party apps & services**, then delete the sheet. |

Deleting a Gmail label never deletes the e-mails in it. Google Help: [Create labels to organise Gmail](https://support.google.com/mail/answer/118708).

---

## 5. Sources and verification notes

* Apps Script quotas: official page [developers.google.com/apps-script/guides/services/quotas](https://developers.google.com/apps-script/guides/services/quotas). Figures above were cross-checked with [ModelMonkey – official limits 2026](https://modelmonkey.io/blog/apps-script-quotas-official) and [Medium – Apps Script quotas 2026](https://medium.com/@stackarchitect123/google-apps-script-quotas-2026-official-limits-6-minute-rule-consumer-vs-workspace-d18245035715).
* Gmail label and filter limits: [Hiver – Gmail limits](https://hiverhq.com/blog/gmail-and-google-apps-limits-every-admin-should-know) and [Gmail Community thread](https://support.google.com/mail/thread/26699103).
* RBI `.bank.in` migration (deadline 31 Oct 2025): [Business Standard](https://www.business-standard.com/finance/news/rbi-asks-banks-to-complete-migration-to-bank-in-domain-by-october-31-2025-125042201515_1.html) and [Law.asia – bank.in / fin.in](https://law.asia/rbi-domain-migration-mandate/).
* The preset bank-domain list in `Code.gs` is a starting point. Verify it against the sender addresses in your own mail.

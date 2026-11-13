// Legal pages (regimen.d). Text is owner-supplied verbatim - do not edit the
// wording; formatting only. The Privacy Policy body is pending owner text
// (tracked in the daily note).

export function termsHtml() {
  return `
<p class="muted"><strong>Effective date:</strong> Nov 13, 2026</p>
<p>These Terms govern your use of regimen.d, the open-source calendar sync software, and the website at regimend.app. Both are provided by Koepke.Tech LLC ("Koepke.Tech," "we," "us"). By downloading, installing, running, or using regimen.d or regimend.app, you agree to these Terms. If you don't agree, don't use them.</p>
<h2>1. What regimen.d is</h2>
<p>regimen.d is self-hosted software. It syncs events from ICS, VCS, webcal, XCal, and JCal feeds, iCloud (CalDAV), and Google calendars into Google Calendar or iCloud, using the official Google Calendar API and Apple's CalDAV service.</p>
<p>You install and run regimen.d on a server you control. Koepke.Tech does not operate a hosted version, does not run your instance, and does not receive your calendar data or credentials.</p>
<h2>2. Open-source license</h2>
<p>regimen.d's source code is released under the MIT License, available at github.com/k0epke/regimen.d. The MIT License governs your rights to use, copy, modify, and distribute the code. These Terms add to that license and do not limit the rights it grants.</p>
<h2>3. Your responsibilities</h2>
<p>Because you run regimen.d yourself, you are the operator of your instance. You are responsible for:</p>
<ul>
<li>Securing your server, network, TLS, <code>.env</code> file, database, and dashboard password.</li>
<li>The Google, iCloud, and other accounts you connect, and keeping their credentials safe.</li>
<li>Having the right to access every calendar feed and account you configure.</li>
<li>Complying with Google's Terms of Service and API policies, Apple's terms, and the terms of any feed provider.</li>
<li>Backing up your calendars before syncing and checking that results are correct.</li>
</ul>
<h2>4. Acceptable use</h2>
<p>Don't use regimen.d or regimend.app to:</p>
<ul>
<li>Break any law or third-party terms.</li>
<li>Access calendars or accounts you aren't authorized to use.</li>
<li>Overload, attack, or disrupt regimend.app, Google, Apple, or any feed host.</li>
</ul>
<h2>5. Third-party services</h2>
<p>regimen.d works with services we don't control, including Google Calendar, Apple iCloud, Telegram (optional alerts), and the calendar feeds you add. We aren't responsible for their availability, changes, accuracy, or policies. Your use of them is governed by their own terms.</p>
<h2>6. Privacy</h2>
<p>See the <a href="/privacy">regimen.d Privacy Policy</a> for how regimend.app and the regimen.d software handle data.</p>
<h2>7. No warranty</h2>
<p>REGIMEN.D AND REGIMEND.APP ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT.</p>
<p>We don't promise that regimen.d is error-free, secure, or that syncs will be complete, accurate, or on time. <strong>Events may be missed, duplicated, changed, or deleted. You use regimen.d at your own risk.</strong></p>
<h2>8. Limitation of liability</h2>
<p>TO THE FULLEST EXTENT ALLOWED BY LAW, KOEPKE.TECH, ITS MEMBERS, AND CONTRIBUTORS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST DATA, MISSED APPOINTMENTS, LOST PROFITS, OR SECURITY INCIDENTS ON YOUR SERVER, ARISING FROM REGIMEN.D OR REGIMEND.APP, EVEN IF WARNED THEY WERE POSSIBLE.</p>
<p>OUR TOTAL LIABILITY FOR ANY CLAIM IS LIMITED TO $50 USD.</p>
<p>Some jurisdictions don't allow these limits, so some may not apply to you.</p>
<h2>9. Indemnification</h2>
<p>You agree to indemnify and hold Koepke.Tech harmless from claims, losses, and expenses (including reasonable attorneys' fees) arising from your use of regimen.d, your instance, or your breach of these Terms.</p>
<h2>10. Changes</h2>
<p>We may change or discontinue regimen.d or regimend.app at any time. We may update these Terms by posting a new version here with a new effective date. Continuing to use regimen.d or regimend.app after that means you accept the update.</p>
<h2>11. Governing law</h2>
<p>These Terms are governed by the laws of the State of Kansas, without regard to conflict-of-law rules. Disputes will be resolved in the state or federal courts located in [County], Kansas.</p>
<h2>12. General</h2>
<p>If any part of these Terms is unenforceable, the rest stays in effect. Not enforcing a right isn't a waiver of it. These Terms, the Privacy Policy, and the MIT License are the entire agreement about regimen.d.</p>
<h2>13. Contact</h2>
<p>Koepke.Tech LLC<br>
Email: <a href="mailto:privacy@regimend.app">privacy@regimend.app</a><br>
Website: <a href="https://regimend.app">regimend.app</a><br>
Issues: <a href="https://github.com/k0epke/regimen.d/issues">github.com/k0epke/regimen.d/issues</a></p>`;
}

export function privacyHtml() {
  return `
<p class="muted"><strong>Effective date:</strong> Nov 13, 2026</p>
<p>regimen.d is self-hosted software from Koepke.Tech LLC ("Koepke.Tech," "we," "us"). <strong>Your calendar data, account credentials, and sync history stay on the server you run. Koepke.Tech never receives them.</strong> This policy explains what the regimen.d software stores on your server and what the regimend.app website collects.</p>
<h2>1. The regimen.d software</h2>
<p>When you run regimen.d, it stores the following in a local SQLite database (and your <code>.env</code> file) on your own server:</p>
<table>
<thead><tr><th>Data</th><th>Why it's stored</th></tr></thead>
<tbody>
<tr><td>Google OAuth refresh token</td><td>To read and write your Google calendars without asking you to sign in each time</td></tr>
<tr><td>Google account email address</td><td>To show which account is connected</td></tr>
<tr><td>iCloud Apple ID and app-specific password</td><td>To read and write iCloud calendars over CalDAV</td></tr>
<tr><td>Dashboard admin password (bcrypt-hashed)</td><td>To protect your dashboard</td></tr>
<tr><td>Sync pairs: feed and calendar URLs, schedules, filters, copy modes, tags</td><td>To know what to sync and how</td></tr>
<tr><td>Event UIDs, content hashes, and run history with error details</td><td>To avoid duplicates, update changed events, and remove events regimen.d created when they leave the source</td></tr>
</tbody>
</table>
<p>Dashboard sessions are kept in memory only and end when regimen.d restarts. Credentials are never written to logs, shown in the dashboard, or put in URLs.</p>
<p>None of this data is sent to Koepke.Tech. It goes only to the services you connect, described below.</p>
<h2>2. Google user data</h2>
<p>regimen.d asks Google for these permissions:</p>
<ul>
<li><strong>Google Calendar</strong> (<code>https://www.googleapis.com/auth/calendar</code>): to read events from Google calendars you choose as sources and to create, update, and delete events in calendars you choose as targets.</li>
<li><strong>Email address</strong> (<code>userinfo.email</code>): to display which Google account is connected.</li>
</ul>
<p>regimen.d uses Google user data only to sync calendars as you configure. It does not sell this data, use it for advertising, or share it with anyone except as needed to sync the calendars you choose. It only changes or deletes events it created itself.</p>
<p>regimen.d's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="external">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>3. Services regimen.d talks to</h2>
<p>Your regimen.d instance sends data directly to these services, and only when you configure them:</p>
<ul>
<li><strong>Google Calendar API</strong>: to read and write Google calendars.</li>
<li><strong>Apple iCloud CalDAV</strong> (<code>caldav.icloud.com</code>): to read and write iCloud calendars.</li>
<li><strong>Calendar feed hosts</strong>: to download the ICS, VCS, webcal, XCal, or JCal feeds you add.</li>
<li><strong>Telegram Bot API</strong> (optional, off by default): to send failure alerts and a daily digest. Alerts include sync pair names, statuses, and short error messages.</li>
</ul>
<p>Each service handles data under its own privacy policy.</p>
<h2>4. Privacy controls</h2>
<p>Per sync pair, you can write events to the target as "busy" or with generic titles, and strip fields such as descriptions or locations. These settings change only what regimen.d writes to the target. Your source calendars are never changed.</p>
<h2>5. Deleting your data</h2>
<ul>
<li><strong>Remove a sync pair</strong> in the dashboard to stop syncing it.</li>
<li><strong>Disconnect Google</strong> in the dashboard, and revoke regimen.d's access anytime at <a href="https://myaccount.google.com/permissions" rel="external">myaccount.google.com/permissions</a>.</li>
<li><strong>Revoke an iCloud app-specific password</strong> at <a href="https://account.apple.com" rel="external">account.apple.com</a>.</li>
<li><strong>Delete everything</strong> by stopping regimen.d and deleting its database file (<code>data/calsync.db</code> by default) and your <code>.env</code> file.</li>
</ul>
<p>Events regimen.d already wrote to your target calendars stay there until you delete them.</p>
<h2>6. Security</h2>
<p>regimen.d binds to <code>127.0.0.1</code> by default and uses bcrypt password hashing, httpOnly session cookies, CSRF protection, and login rate limiting. Because you host it, you are responsible for securing your server, TLS, database, and <code>.env</code> file.</p>
<h2>7. The regimend.app website</h2>
<p>The regimend.app website does not require an account and does not collect calendar data. Like most websites, our web server may record standard request logs, such as IP address, browser type, pages requested, and time of visit. We use these logs only to run and secure the site and do not sell or share them.</p>
<h2>8. Children</h2>
<p>regimen.d and regimend.app are not directed at children under 13, and we don't knowingly collect their personal information.</p>
<h2>9. Changes</h2>
<p>We may update this policy. We'll post the new version here with a new effective date.</p>
<h2>10. Contact</h2>
<p>Koepke.Tech LLC<br>
Email: <a href="mailto:privacy@regimend.app">privacy@regimend.app</a><br>
Website: <a href="https://regimend.app">regimend.app</a></p>`;
}

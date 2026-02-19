=== ARTICO SALES APP — PROJECT CONTEXT ===



Company: Artico PTY LTD (Australian wholesale gift company)

Brands: Name a Star, Shall We Bloom, Salt \& Wattle,

&nbsp;       Better Read Than Dead, Australian Made Range

Retail doors: ~1,500 across Australia



THIS APP: sales.artico.au

Purpose: Territory intelligence and revenue visibility for field sales team

NOT an ordering app — orders stay in PixSell



USERS:

&nbsp; - Rep: sees own data only, logs visits

&nbsp; - Manager: sees all reps, sets targets

&nbsp; - Executive (Owain): sees everything, sets targets



PRIMARY DEVICE: iPhone / mobile-first responsive web app



ZOHO BOOKS:

&nbsp; API: www.zohoapis.com/books/v3  ← US data centre (not .com.au)

&nbsp; Org ID: 689159620

&nbsp; Auth: OAuth2, refresh token via Render env vars

&nbsp; Scope: ZohoBooks.fullaccess.all

&nbsp; Store grades (A/B/C): custom field on Contact in Zoho

&nbsp;   → CHECK: does cf\_store\_grade exist? Create if not.



DEPLOYMENT:

&nbsp; Platform: Render (paid plan, persistent disk)

&nbsp; GitHub: auto-deploy on push

&nbsp; DNS: GoDaddy CNAME to Render

&nbsp; Stack: Node.js / Express + PostgreSQL



EXISTING APPS FOR REFERENCE:

&nbsp; factory.artico.au — Factory Tracker (Node/Express, same Zoho OAuth pattern)



UI:

&nbsp; Use the frontend-design skill for all UI work.

&nbsp; Mobile-first, clean, data-dense.

&nbsp; Orange #E8501A accent, Navy #1B3A6B headers.



COMPLETED PROMPTS:

&nbsp; ☐ Prompt 1: Foundation \& Schema

&nbsp; ☐ Prompt 2: Zoho Integration

&nbsp; ☐ Prompt 3: Auth + Target Setting

&nbsp; ☐ Prompt 4: Revenue Dashboards

&nbsp; ☐ Prompt 5: Visit Logging \& New Doors

&nbsp; ☐ Prompt 6: Alert Engine

&nbsp; ☐ Prompt 7: Product Intelligence \& Scoreboard



=== END CONTEXT ===


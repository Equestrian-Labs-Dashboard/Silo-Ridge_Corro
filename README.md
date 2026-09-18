# Silo Ridge — Corro Sales Report

A standalone GitHub Pages report based on the HITS Hudson visual language, simplified for the Silo Ridge event.

## Business requirement

Source only Shopify orders that meet **both** conditions:

1. Location / warehouse: **Corro Trailer 1** (`locationId: 67063775290`)
2. Order tag: **SiloRidge** (accepted variants are configured in `config/report-config.json`)

The report shows:

- Manual event OPEX by category (Hotel, Traveling Staff, Transportation, Trailer Expenses, and Other Event Expenses), with a default total placeholder of `$5,000`; saved in browser localStorage
- Gross Sales
- Net Sales
- Gross Profit
- Gross Margin
- Units
- Units per Order
- AOV
- Orders (supporting audit KPI)
- Event Contribution and OPEX Coverage (secondary decision metrics)
- Dynamic weekly detail
- Qualifying order audit

## Important accounting logic

- `Net Sales = Gross Sales - Discounts - Returns`
- `Gross Profit = Net Sales - COGS`
- `Gross Margin = Gross Profit / Net Sales`
- `Units / Order = Units / Orders`
- `AOV = Net Sales / Orders`
- `Event Contribution = Gross Profit - Manual Total OPEX`
- Total OPEX is manual and **does not include inventory/COGS**.

## GitHub Actions secrets

Because this report uses the same Corro Shopify store as HITS Hudson, it uses the **same two secret values**:

- `SHOPIFY_STORE` — e.g. `equestrian-labs.myshopify.com`
- `SHOPIFY_TOKEN` — the same Shopify Admin API access token used by the HITS Hudson repository

No Google Sheets, service account, Smartrr secret, or additional Shopify credential is required.

> Repository Secrets are normally repo-specific. If you create a new repository, add the same two values again under **Settings → Secrets and variables → Actions**, unless they are already provided through organization-level secrets.

## Deploy

1. Create a new GitHub repository, suggested name: `Silo-Ridge_Corro`.
2. Upload the contents of this folder to the **root** of that repository.
3. Add `SHOPIFY_STORE` and `SHOPIFY_TOKEN` in **Settings → Secrets and variables → Actions**.
4. Go to **Settings → Pages** and set Source to **GitHub Actions**.
5. Go to **Actions → Update Silo Ridge report → Run workflow**.
6. After it finishes green, the `Deploy GitHub Pages` workflow publishes `docs/`.
7. Open the GitHub Pages URL. If there are no Silo Ridge sales yet, the page remains a valid zero-data draft and will populate automatically later.

## Automatic refresh

`Update Silo Ridge report` also runs hourly at minute 23.

## Configuration

Edit `config/report-config.json` if the live Shopify tag differs. Current accepted tag variants:

- `SiloRidge`
- `Silo Ridge`
- `Silo-Ridge`
- `Silo Rich`
- `Siler Rich`
- `Silo`
- `Ridge`
- `SiloRodge` (included defensively because this spelling appeared in the working notes)

The ETL uses a strict **location AND tag** rule. It does not include all Trailer 1 sales.

## Weekly logic

The ETL scans Shopify starting on `2026-09-01` so early tagged transactions are not missed.

- If matching orders already exist, Week 1 starts on the Monday of the first matching order and weeks expand through the latest/current event week.
- If no matching sales exist yet, the dashboard shows a draft Week 1 of Sep 28–Oct 4, 2026.

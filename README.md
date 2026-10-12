# CEVA SKU Catalog

Associates enter a SKU in `skucatalog.html` and see its description, handling
notes and photo. Admins unlock with the admin password to add photos and notes
and to see unit cost.

## How it fits together

- `skucatalog.html` is the page associates use. It holds no data and no password.
- `worker/` is a Cloudflare Worker that serves the API. SKUs live in a Cloudflare
  D1 database and photos in an R2 bucket. Unit cost is only returned to a
  logged-in admin.
- `scripts/build_import_sql.py` turns the pricing spreadsheet into SQL for D1.
- `scripts/migrate_catalog_json.py` moves the photos and notes from the old
  `catalog.json` into the new catalog. It only needs to run once.

The pricing spreadsheet and the SQL generated from it contain cost data. Never
commit them; `.gitignore` blocks the usual file names.

## One-time setup

Run these from the `worker/` folder with Node installed and
`npx wrangler login` done once.

1. Create the database and bucket:
   ```sh
   npx wrangler d1 create ceva-sku-catalog       # paste the database_id into wrangler.toml
   npx wrangler r2 bucket create ceva-sku-photos
   npx wrangler d1 execute ceva-sku-catalog --remote --file=schema.sql
   ```
2. Set the admin password (it is prompted for, not typed on the command line):
   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   ```
3. Deploy the Worker:
   ```sh
   npx wrangler deploy
   ```
   If the URL it prints differs from `API_URL` in `skucatalog.html`, update `API_URL`.
   If the page is served from somewhere other than `https://cevanortam.github.io`,
   add that origin to `ALLOWED_ORIGINS` in `wrangler.toml`.
4. Import the pricing list:
   ```sh
   python3 ../scripts/build_import_sql.py /path/to/Pricing.xlsx ../import.sql
   npx wrangler d1 execute ceva-sku-catalog --remote --file=../import.sql
   ```
5. Bring over the existing photos and notes:
   ```sh
   python3 ../scripts/migrate_catalog_json.py ../catalog.json ../migration
   npx wrangler d1 execute ceva-sku-catalog --remote --file=../migration/migrate.sql
   ../migration/upload_photos.sh
   ```

## Updating prices later

Re-run step 4 with the new spreadsheet. It updates description, cost,
material and plant for every SKU and adds new ones. Notes and photos are never
changed. An admin's edit to a description is replaced by the spreadsheet's
description on the next import.

# seLe4n Website

Static marketing site for **seLe4n**.

## Data synchronization

Live metrics are now sourced from `data/site-data.json` first, so desktop and mobile clients render the same baseline data.

To refresh those metrics from `hatter6822/seLe4n`:

```bash
node scripts/sync-site-data.mjs
```

Then commit the updated `data/site-data.json` file.

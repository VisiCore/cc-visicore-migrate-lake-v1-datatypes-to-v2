# Migrate Lake DataTypes From v1 to v2

Move Cribl Lake Datasets from v1 Datatypes to v2 Datatypes, with a recommended Datatype ID for each Dataset.

## Screenshots

![Overview page: share of Datasets migrated, Datasets left on v1, median search speed change, and search speed by Dataset](https://raw.githubusercontent.com/VisiCore/cc-visicore-migrate-lake-v1-datatypes-to-v2/main/screenshots/overview.png)

![Datasets page: each Lake Dataset with its size, search type, v2 Datatype ID, status, and search speed before and after](https://raw.githubusercontent.com/VisiCore/cc-visicore-migrate-lake-v1-datatypes-to-v2/main/screenshots/datasets.png)

## Summary

Migrate Lake DataTypes From v1 to v2 is a Cribl app for switching Cribl Lake Datasets to the v2 search type. It helps users see which Datasets are still on v1, choose the right v2 Datatype ID for each one, and migrate, verify, or revert them without opening every Dataset by hand.

## What This App Does

* Primary purpose: change a Lake Dataset's search **Type** from v1 to v2 and set its v2 Datatypes, the same change you would make in the Dataset's settings in Cribl Search.
* Key capabilities:
  * Lists every Lake Dataset with its storage format, search type, v1 Datatypes, and the v2 Datatype ID it would get.
  * Recommends a v2 Datatype ID for JSON Datasets by sampling 50 events and comparing them with every eligible v2 Datatype. Shows the evidence for each recommendation.
  * Migrates one Dataset or many at once, and can add the second data format row (Parquet on a JSON Dataset, or JSON on a Parquet Dataset).
  * Runs a test search after migration to confirm the search ran on v2 and which `datatype` values came back.
  * Creates a custom JSON Datatype from the review panel when no existing one fits: choose an ID and where the timestamp comes from.
  * Measures search speed on v1 just before a migration and on v2 just after, and shows the change per Dataset and the median across Datasets.
  * Shows an Overview page for the big picture: share of Datasets migrated, how many remain, and the median and per-Dataset change in search speed.
  * Leaves empty Datasets out of the list and the progress numbers: those Cribl Lake reports no stored data for, and those whose analysis found no events. **Show empty Datasets** brings them back.
  * Lets you hide Datasets you don't intend to migrate (for example, empty ones) so the list shows only what's left. Hiding changes nothing in Cribl Lake.
  * Reverts a Dataset to v1. The v1 Datatypes stay on the Dataset while it is on v2, so they come back unchanged.
* Intended users:
  * Admin / Platform owner
* Works with:
  * Cribl Lake and Cribl Search on Cribl.Cloud

## When To Use This App

* You have Lake Datasets on v1 Datatypes and want to move them to v2.
* You are unsure which v2 Datatype ID fits a Dataset and want a recommendation based on its data.
* You want to migrate many Datasets in one pass instead of editing each one.

## Before You Install

* Required Cribl product or deployment type: Cribl.Cloud with Cribl Lake and Cribl Search.
* Required permissions or roles: the user must be allowed to edit Lake Datasets and run searches. The app's own grants are listed under **Permissions**.
* Required external systems or APIs: none.
* Required configuration values: none.
* Known limits or prerequisites: only Datasets in the `default` Lake are listed.

## Installation

### Install From Marketplace or URL
1. Go to Apps in your Cribl environment.
2. Choose the Marketplace or import from URL option.
3. Install the app and review the API access it requests.

### If The App Is Not Yet In The Cribl Marketplace
1. Clone https://github.com/VisiCore/cc-visicore-migrate-lake-v1-datatypes-to-v2, run `npm install`, then build the package with `npm run package`.
2. In Cribl, go to Apps and choose import from file.
3. Upload the `.tgz` file and complete installation.

## Configuration

The app has no settings.

## How To Use

### Typical Workflow
1. Open the app and select **Datasets**. The table lists every Lake Dataset and whether it is on v1 or v2. Cribl's system Datasets (`cribl_logs`, `cribl_metrics`, `default_logs`, `default_metrics`, `default_spans`, `default_events`) are hidden until you select **Show system Datasets**.
2. Select a Dataset's name to open its review panel.
3. For a JSON Dataset, select **Analyze sample events** to check its data against the v2 Datatypes. Keep the recommended Datatype ID or pick another.
4. Optionally select **Also read Parquet data in this Dataset** (or JSON, on a Parquet Dataset).
5. Select **Migrate to v2** and confirm.
6. The app then runs a test search to verify the Dataset really searches on v2, shows the result in the **Status** column, and only then measures v2 search speed. You can re-run it from the review panel with **Run test search**.

To migrate several Datasets, select their rows, select **Analyze sample events**, then select **Migrate to v2**. Each Dataset gets the Datatype ID shown in its row. The **Status** column shows which Datasets were analyzed, which returned no events, and which failed; the confirmation warns about any that were not checked.

### First-Run Checklist
* Analyze and migrate one low-risk Dataset first.
* Run the test search and check the results in Cribl Search.
* Then migrate the rest in bulk.

## Permissions

If a user lacks access to an endpoint, the app shows the API error and makes no change.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/products/lake/lakes/default/datasets` | List Lake Datasets and their search configuration. |
| GET | `/api/v1/products/lake/lakes/default/datasets/{id}` | Re-read one Dataset immediately before saving it. |
| PATCH | `/api/v1/products/lake/lakes/default/datasets/{id}` | Save the Dataset with its search configuration changed (migrate to v2, change Datatypes, revert to v1). |
| GET | `/api/v1/m/default_search/search/datatypes` | List v2 Datatypes to choose from. |
| POST | `/api/v1/m/default_search/search/datatypes` | Create a custom JSON Datatype when no existing one reads a Dataset's timestamps correctly. Never overwrites an existing Datatype. |
| POST | `/api/v1/m/default_search/search/jobs` | Start a small search to sample a Dataset's events. |
| GET | `/api/v1/m/default_search/search/jobs/{id}/status` | Wait for the search to finish. |
| GET | `/api/v1/m/default_search/search/jobs/{id}/results` | Read the sampled events. |

## External API Access

The app makes no external calls.

### Default Configuration
* `default/policies.yml` — the Cribl API paths in the table above.
* `default/proxies.yml` — empty.

## Data And Storage

* The app stores three KV keys, shared by everyone who uses the app: `empty`, the Datasets whose last analysis found no events; `benchmarks-24h`, the search-speed timings per Dataset (run time, event count, when measured), and `hidden`, the IDs of Datasets set aside from the list. Recommendations and sampled events live only in the open page; nothing is kept in browser storage.
* The only things it changes are the `searchConfig` of the Lake Datasets you confirm and any custom Datatype you choose to create. Stored data, retention, format, and description are sent back unchanged, and the app reports an error if any of them differ after a save.
* Each analysis or test search creates one search job limited to 50 or 10 events. Measuring search speed runs two searches that count the last 24 hours of events; a migration with measurement on runs four per Dataset (two before, two after).

## Support

### Partner Built
This app is built by VisiCore Tech. VisiCore Tech owns support, maintenance, and feature requests for this app; Cribl does not provide direct support for app-specific behavior. Contact CriblPacks@VisiCoreTech.com, or open an issue at https://github.com/VisiCore/cc-visicore-migrate-lake-v1-datatypes-to-v2/issues.

## Known Limitations

* Recommendations cover JSON Datasets. Parquet Datasets default to `cribl_lake_parquet` and Splunk DDSS Datasets to `splunk_journal`.
* Search speed is the run time of one fixed search (a count of the last 24 hours), best of two runs. It indicates the change for that kind of search; other searches may gain more or less, and results vary with load.
* A recommendation is evidence, not proof. Sample events and the test search are the check.
* Datasets in other storage formats (for example Netskope) cannot use v2 and are marked **Not supported**.
* Only v2 Datatypes without Additional Extractions, Schema Maps, or Add Fields are offered, matching the limits of v2 federated search.

## Troubleshooting

### The App Opens But Some Features Do Not Work
* A 401 or 403 error means the app's policies were not granted or the user cannot edit Lake Datasets or run searches.

### Analysis Finds No Events
* Choose a longer time range, or pick the Datatype ID yourself.

### The Test Search Still Reports v1
* Dataset configuration can be cached briefly after saving. Wait a moment and run it again.

## Development

```bash
npm install
npm run dev
npm run package
```

* `src/api.ts` — every Cribl API call the app makes.
* `src/migration.ts` — how a Dataset's search configuration is converted between v1 and v2.
* `src/recommend.ts` — the Datatype ID recommendation.
* `src/DatasetsPage.tsx`, `src/ReviewDrawer.tsx` — the UI.

## Project Layout

```text
src/
  api.ts
  migration.ts
  recommend.ts
  DatasetsPage.tsx
  ReviewDrawer.tsx
  App.tsx
config/
  policies.yml   [Cribl API access grants]
  proxies.yml    [external domain declarations — none]
README.md
```

## App Metadata

| Field | Value |
|---|---|
| App Name | Migrate Lake DataTypes From v1 to v2 |
| App ID | cc-visicore-migrate-lake-v1-datatypes-to-v2 |
| Version | 1.0.0 |
| Author | VisiCore Tech - CriblPacks@VisiCoreTech.com |
| Support Model | partner-built |
| Support Label | Partner Built |
| Support Contact | CriblPacks@VisiCoreTech.com |
| License | [SPDX identifier or "See LICENSE"] |
| Product Tags | lake, search |
| Category | Administration |
| Audience | admin, platform-owner |
| Availability | preview |
| Requires External Access | no |
| Repository | https://github.com/VisiCore/cc-visicore-migrate-lake-v1-datatypes-to-v2 |
| Documentation | https://docs.cribl.io/search/federated-v2 |
| README Schema Version | 1.0 |

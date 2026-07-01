# Montrose Property Search

A small local applet for searching Montrose County EagleWeb with one input box.

## Run

```bash
cd ~/.cursor/montrose-property-search
node server.mjs
```

Open [http://localhost:3847](http://localhost:3847)

## What it searches

One query box accepts:

- **Owner name** — `Troy Masters` or `Masters Troy`
- **Account number** — `R0007980`
- **Parcel number** — `4269-302-00-055`
- **Street address** — `203 Highway 97`

The server routes the query to the right EagleWeb field and falls back to other interpretations when needed.

## How it works

1. Starts a public EagleWeb session (`guest=true`)
2. Posts the search to Montrose County's `results.jsp`
3. Parses and returns matching accounts in the local UI

## Critical care unit tax estimate

Each search result now includes:

- **Non-school assessed value** from EagleWeb Assessment History
- **Estimated annual/monthly tax increase** from the proposed mill levy

Formula:

```text
annualIncrease = nonSchoolAssessedValue × millLevy ÷ 1000
```

### Set the mill levy

Option 1 — enter it directly in `levy.config.json`:

```json
"millLevy": 20
```

Option 2 — derive it from a sample property shown in your photos:

```bash
node derive-levy.mjs --increase 350.80 --assessed 17540
```

That example uses a $350.80 annual increase on a $17,540 non-school assessed value, which implies a **20.000 mill** levy.

Restart the server after changing the levy config.

Data comes directly from [Montrose County EagleWeb](https://eagleweb.montrosecounty.net/eagleassessor/web/).

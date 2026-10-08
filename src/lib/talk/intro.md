<!-- `---` starts a new slide. Headings, lists, tables and images are the slide; plain paragraphs are speaker notes. A slide that starts with `#` gets the title-slide style. -->

# Client-Side DuckDB: Data Cleaning in the Browser

### Maxym Malynowsky, OCHA Centre for Humanitarian Data

### CNG Forum 2026

This page is both the slides from the talk and a standalone introduction to the tools. Paragraphs like this one are the notes. Press P to switch to presentation mode, and use the arrow keys to move between slides.

---

# What COD-ABs are, and why they matter

---

## COD-ABs: the common map of a humanitarian response

![Cameroon's COD-AB at three levels, 10, 58 and 360 units, with one unit highlighted at each: Centre (CM002), Mbam-et-Kim (CM002004) and Yoko (CM002004005)](/talk/cmr-admin-levels.svg)

- Admin boundaries for a common operational picture, most often sourced from national authorities
- P-codes: a stable code for every unit, down to the lowest level available
- Maintained by OCHA for the countries where it operates

COD-AB stands for Common Operational Dataset for Administrative Boundaries. In a crisis, everyone responding needs to agree on where the provinces and districts are and what they're called. The COD-AB is that shared reference, endorsed in-country and published openly. In Cameroon, each P-code extends its parent's: Yoko is CM002004005, inside Mbam-et-Kim (CM002004), inside Centre (CM002).

OCHA maintains COD-ABs for 114 of 248 countries and territories, including every country with an active humanitarian response plan this year.

---

## HDX: the Humanitarian Data Exchange

<!-- wide -->

![Two bar charts. Left: the ten most downloaded datasets on HDX of all time, five of them COD-ABs (Philippines, Bangladesh, Thailand, Ethiopia and Pakistan). Right: the ten files people downloaded most from the HDX website in one month, all of them COD-ABs](/talk/hdx-downloads.svg)

- OCHA's open data platform since 2014, run by the Centre for Humanitarian Data
- 28,000 datasets from 233 organizations
- More than 500,000 users a month
- COD-ABs: less than 1% of datasets, ~10% of downloads

HDX is where organizations share data across crises. Most of its traffic is programmatic: in a month, 555,000 unique users made 1.48 million downloads. The 170 COD-AB datasets account for 1.2 million of its 13.4 million all-time downloads, and five of the ten most downloaded datasets are COD-ABs. About 35,000 users a month browse HDX as people, and when they download from the website, they download boundaries: the ten most downloaded files in a month are all COD-ABs, and eight of the ten datasets with the most notification subscribers are COD-ABs too.

All-time counts are from HDX's public API in October 2026, and monthly figures from HDX's September 2026 analytics report. The all-time top ten leaves out a repository of PDF files, which has the most downloads but is a file store, not a dataset.

---

## Tabular data on HDX joins on COD-ABs

| Category             | Examples                                                   |
| -------------------- | ---------------------------------------------------------- |
| Population           | Baseline population, displaced people, refugees, returnees |
| Situation and needs  | Needs assessments, food security, market prices, poverty   |
| Risk                 | Rainfall, vegetation, national risk                        |
| Services             | Who does what, where                                       |
| Funding              | Humanitarian funding                                       |
| Appeals, emergencies | Response plans, emergency declarations                     |
| Protection           | Protection risks and incidents                             |

These are the kinds of tabular data on HDX, and they all locate their rows by admin unit through COD-AB P-codes. HAPI, the HDX Humanitarian API, standardizes indicators from many organizations into one schema. Nine of its thirteen indicators are reported by admin unit, and they line up only because they share COD-AB P-codes. It also taught us that standardizing other people's data after the fact doesn't scale.

The Humanitarian Data Model replaces it, and its draft is being agreed across agencies. Most of HAPI's data carries over into the model's domains, and the model adds new ones. Every domain locates its data through the Location domain, which holds the admin boundaries.

---

## Boundaries are how people get counted

![Map of Afghanistan by district, shaded by the share of the population in need in 2025, from under 40% to over 70%](/talk/afg-people-in-need.svg)

People in need are counted by district, against a baseline population for that district, and that's how aid gets targeted. Here it's Afghanistan in 2025: 22.9 million people in need out of 46 million.

400 of the 401 districts in the needs data join to the COD-AB on their P-code. The one that doesn't is Khulm, coded AF2110 in the needs data and AF2008 in the boundaries, so a plain join silently drops it.

---

# The problems: fragmentation and delays

---

## Each agency keeps its own global boundaries

![World map with a dot in each of the 40 countries where OCHA has a country office, regional office or humanitarian advisory team](/talk/ocha-presence.svg)

- OCHA, WFP, UNICEF, UNHCR and IOM each maintain one, and so do FAO, the World Bank and others
- Their field presence overlaps in some countries, and in others only one agency is there

Each dot is a country where OCHA has a country office, a regional office or a humanitarian advisory team. That's where OCHA has people with local knowledge of the boundaries.

The other agencies each have their own map like this, and their own global boundary dataset built from it. Where they overlap, we have competing versions. Where they don't, one agency may hold the only good data.

---

## Sources often disagree on the geography

<!-- explorer -->

These maps come from the HDX Boundaries Explorer, which compares admin boundaries from seven sources. For six African countries, they show OCHA's COD-AB in blue, then another source in red.

In the Central African Republic, Mali and Ghana, the COD-AB has more admin 1 units than the other source: 20 against FAO's 7, 20 against WFP's 10 from 2023, and 16 against UNICEF's 10. Madagascar is the extreme case, 24 against the World Bank's 6. Burkina Faso's 2025 release has 17 regions with new names, where UNICEF still has the old 13. South Sudan goes the other way: the World Bank has 12 units because it counts Ruweng and Pibor as their own areas, and OCHA has 10.

---

## Even where the geography matches, the codes differ

| Source   | Code for Kabul     |
| -------- | ------------------ |
| Source A | `AF0101`           |
| Source B | `1044590`          |
| Source C | `AFG_0014_0009_V1` |
| Source D | `21AFG001001`      |

The same city, with the same boundary, carries a different code in each source. So data gets re-coded every time it moves between agencies, and joins break when a code is mapped wrong.

---

## The people with local knowledge lack the tools, and the experts are stretched

- Excel and ArcGIS in the field, at most a basic ArcPy script, no AI
- A few central experts cleaning topology by hand, for weeks per country
- Data going back and forth for months

The people who know the ground are in country offices and national agencies. They know which districts split and what the names should be, but their tools stop at Excel and desktop GIS.

The specialist work happens centrally, with a very small team. In Mali, it took 121 days to get data back from the field, and the government's codes didn't match ours.

---

# Converging on a standard

---

## UN80 brought the agencies to the same table

![Geospatial workshop participants at WFP in Rome](/talk/rome.jpg)

- UN80: reform across the UN system to bring efficiency, with one evidence base for humanitarian data
- Rome, June 2026: five UN humanitarian agencies agreed one P-code standard, one update process, and a global COD-AB by the end of 2026
- Then the broader humanitarian community from 2027

UN80 is the reform effort across the UN system. Its report commits to a Humanitarian Data Collaborative so that all actors can work from one evidence base.

For boundaries, that meant getting the five agencies in a room. Over three days in Rome we agreed the P-code specification, the governance process for updates, and the roadmap. We're starting with OCHA's own process, then the five agencies, then partners like FAO and the World Bank.

---

## Lessons from STAC

- Tools before the standard was final: Ethiopia, Mozambique and DR Congo were cleaned while the standard was being agreed, and the lessons fed into it
- A validator anyone can run: country offices check their own data before they submit it
- Built for the people doing the work: ArcGIS and Excel users in the field

Element 84's STAC retrospective says a standard earns its authority through use, and warns against "if you build it, they will come". This audience has seen it work with STAC, GeoParquet and COG.

We also built on what already exists: GeoParquet, DuckDB, and P-codes aligned with UN Secretariat conventions.

---

# From concepts to tools

---

## Cleaning in six steps

<!-- steps -->

Every boundary update goes through the same six steps: map the source schema, clean the topology, match the edges to the international boundary, carry the codes over from the last release, clean the names, and package the result.

Each demo later in the talk is one of these steps.

---

## Two tools, starting with the CLI

<!-- duckdb -->

- The Python CLI came first, because it's faster to iterate on
- The web app was planned from the start and built once the workflow worked

Each step is DuckDB spatial SQL, with GeoParquet between steps, so any intermediate result can be opened and checked. Because the logic lives in SQL, the same queries run in the browser.

---

## Tools, then docs, then skills

- Tools: the CLI does the work on its own, no AI needed
- Docs: describe how to use the tools
- Skills: Claude Code follows the docs to drive the tools

Each layer sits on top of the one before it, and the skills are optional.

The skills open the CLI up to colleagues who are comfortable with data but aren't software developers. Our Field Information Services team works this way in VS Code on Windows, and went from about one country a week to several a day.

---

## Validated on real countries, then ported to the browser

- Topology cleaning: from weeks by hand to minutes
- DuckDB-WASM runs the same SQL, with nothing to install
- Files stay on the local machine, and the app works offline once cached

Some partners don't have Python or an AI subscription, and some can't install software at all. The browser app is a static site with no server, built with Astro, Svelte and MapLibre. Most of the work went into making the UI easy to use.

The demo uses Netherlands admin boundaries. Each of the next slides embeds one tool, live, with its demo file loaded.

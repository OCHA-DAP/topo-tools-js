<!-- `---` starts a new slide. Headings, lists, tables and images are the slide; plain paragraphs are speaker notes. -->

# Client-Side DuckDB: Data Cleaning in the Browser

### Maxym Malynowsky, OCHA Centre for Humanitarian Data

### CNG Forum 2026

This page is both the slides from the talk and a standalone introduction to the tools. Paragraphs like this one are the notes. Press P to switch to presentation mode, and use the arrow keys to move between slides.

---

## UN80 and the Data Quint

- UN80: reform across the UN system, report published September 2025
- The Data Quint: OCHA, WFP, UNICEF, UNHCR, IOM
- Shared work on core data, geodata, analysis and capacity

UN80 is the reform effort across the UN system. Its report, published in September 2025, commits to a Humanitarian Data Collaborative so that everyone can work from one evidence base.

The Data Quint is five agencies working on that together: OCHA, WFP, UNICEF, UNHCR and IOM. The work is split into a few focus areas, and the two with the most momentum are core data and geodata.

---

## The Humanitarian Data Model

- Each agency keeps its own systems
- Datasets join on shared dimensions: geography and time
- Plus shared vocabularies: population group, cluster, gender

The direction the quint has settled on is the Humanitarian Data Model. It's federated: our files don't need to live in the same place, they need to be joinable.

To test this, the core data group took real Afghanistan data from all five agencies and tried to answer a few common questions with it. Joining it by hand took a lot of manual work and institutional knowledge, and two analysts joining the same files in different ways can get very different answers.

---

## Geography is the join key

| Source   | Code for Kabul     |
| -------- | ------------------ |
| Source A | `AF0101`           |
| Source B | `1044590`          |
| Source C | `AFG_0014_0009_V1` |
| Source D | `21AFG001001`      |

Almost every one of those joins goes through geography, and for most humanitarian data that means administrative boundaries. Today the same city can carry a different code in each source, so data gets re-coded every time it moves between agencies.

The geodata group's goal is one global set of admin boundaries for the quint: no gaps, down to the lowest admin level available, with globally unique and versioned codes, edge-matched to its neighbours, and updated continuously. That dataset is the COD-AB, OCHA's Common Operational Dataset for Administrative Boundaries.

---

## The 2026 roadmap

- June: P-code standard and update process agreed by all five agencies
- Q3: cleaning, comparison, P-coding and QC tools
- Q4: public global COD-AB v1
- 2027: adoption across the quint, then more partners

At a workshop in Rome at the end of June, the five agencies agreed on a common P-code standard, a standard operating procedure for updates, and a roadmap to a public global dataset by the end of 2026.

One line on that roadmap is cleaning, comparison, P-coding and QC tools, which is what the rest of this talk covers.

---

## The scale of it

- About 249 countries and territories
- About 6 weeks from candidate to publication
- A growing backlog, and less geodata capacity after 2025
- Target: 2 weeks

COD-AB covers about 249 countries and territories, and OCHA and the quint partners rely on it. In April the average time to publish an update was around six weeks, the backlog was growing, and staff reductions in 2025 had cut geodata capacity. The process improvement project set a target of two weeks.

---

## How it's done today

- Work orders and evaluation checklists in Excel
- ArcGIS Pro licences, up to 25 days to onboard
- SharePoint sync over low-bandwidth connections
- ArcGIS and QGIS tolerances disagree, so some errors surface after publication
- Publication depends on very few people

We mapped the whole process end to end, using Mali as the worked example. It has nine steps, from an annual survey of country offices to checks after publication, and most of the tooling is Excel and ArcGIS.

Each step works on its own, but the handoffs are slow. In Mali it took 121 days to get data back from the field. Different tools use different tolerances, so HDX sometimes catches topology errors after a dataset is already published.

---

## What makes boundaries hard

- Source schemas vary country by country
- Gaps and overlaps between units
- Outer edges have to follow international boundaries
- Codes have to carry over from one version to the next

Boundary data comes from national authorities, and every country delivers it differently. The column names change, levels get merged or skipped, and units don't always nest inside their parents.

Most of these problems aren't visible in an attribute table. You have to look at the geometry, and you have to compare against the previous release.

---

## Step 1: write it down as SQL

- topo-tools-py: a Python CLI on DuckDB spatial
- Schema → topology → edge matching → codes → names → packaging
- GeoParquet between every stage
- A person confirms every decision

The first step was turning the checklist into code. topo-tools-py runs each stage as DuckDB spatial SQL and writes GeoParquet between stages, so any intermediate result can be opened and checked.

It doesn't make decisions on its own. Things like which codes to keep, or how wide a gap to fill, stop and wait for someone to confirm.

---

## Step 2: Claude drives the CLI

- OCHA Field Information Services, Istanbul
- ArcGIS and Excel users, not programmers
- Claude Code in VS Code on Windows, with the topo-tools plugin
- One country a week → several a day

A CLI is still a barrier for most people who do this work. Our Field Information Services team in Istanbul works in ArcGIS and Excel.

We packaged the workflow as a Claude Code plugin, with a skill that walks through each stage, and they run it in VS Code on Windows. They went from about one country a week to several a day. Claude also turned out to be good at spotting names and P-codes that break the pattern of their neighbours, which is tedious to catch by hand.

---

## Step 3: nothing to install

- Not every partner has Python, or an AI subscription
- Same stages, same SQL, running in DuckDB-WASM
- Drag a file in. Nothing is uploaded
- Works offline once cached

Some partners don't have Python or an AI subscription, and some can't install software at all. So the same workflow runs two ways: the CLI for AI-assisted sessions, and a browser app for everyone else. Keeping the two at feature parity is a hard requirement.

The browser app is a static site with no server. Files are processed on your own machine and never leave it, which helps on slow connections and for anyone who isn't ready to share a draft yet.

---

## How it works

- Astro static site, Svelte islands
- DuckDB-WASM with the spatial extension
- MapLibre GL for the map
- GeoParquet over HTTP, demo data on Source Cooperative

Each tool is a page with a small Svelte app. All of the geospatial logic is SQL run by DuckDB's spatial extension, the same approach as the Python version. DuckDB-WASM runs single-threaded in the browser.

---

## Live demo

- Netherlands admin boundaries
- Each of the next slides runs a tool with its demo file loaded

The demo uses Netherlands admin boundaries. Each of the next slides embeds one tool, live, with its demo file already loaded. Any tool page also has a "Try with demo data" link.

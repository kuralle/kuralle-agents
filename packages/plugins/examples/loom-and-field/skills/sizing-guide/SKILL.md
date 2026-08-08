---
name: sizing-guide
description: Loom & Field body measurements and size selection. Load before recommending a size or answering fit questions.
---

# Sizing guide (Loom & Field)

**Skill teaches fit policy; MCP tools execute catalogue lookups.** This document explains how to
help customers choose a size. It does not contain the numeric size chart — those measurements
live in a bundled reference file you must fetch on demand.

## When to load this skill

- A customer asks whether a size will fit.
- You need chest, waist, or hip measurements for a Loom & Field size label.
- You are comparing the customer's measurements to the brand chart.

## Size chart reference

The authoritative Loom & Field tops size chart is in **`references/size-chart.md`**. Read that
file with `read_skill_resource` before quoting any measurement — the numbers are not duplicated
here on purpose.

## Procedure

1. Load this skill when a fit or sizing question arrives.
2. Read `references/size-chart.md` and cite the exact measurement from that file.
3. Use MCP tools (`filter_by_size`, `check_stock`, `get_product_details`) for catalogue facts.

If a customer is between sizes, recommend the larger size for outerwear and the smaller for
tailored shirts unless they prefer a relaxed fit.

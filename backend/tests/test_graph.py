"""/api/graph — build_graph passthrough shape + mtime-keyed cache invalidation."""

from __future__ import annotations

import os
from pathlib import Path


async def test_graph_shape(client):
    resp = await client.get("/api/graph")
    assert resp.status_code == 200
    graph = resp.json()

    assert set(graph) == {"nodes", "edges", "types"}
    assert graph["types"] == ["Concept", "Organization", "Summary"]

    nodes = {n["id"]: n for n in graph["nodes"]}
    assert set(nodes) == {
        "summaries/demo-paper",
        "summaries/transformers-survey",
        "concepts/attention-mechanism",
        "concepts/sequence-modeling",
        "entities/vaswani-et-al",
    }
    demo = nodes["summaries/demo-paper"]
    assert demo["label"] == "demo-paper"
    assert demo["type"] == "Summary"
    # full_text is inserted at the front of sources.
    assert demo["sources"][0] == "sources/demo-paper.md"
    assert {"in", "out"} <= set(demo)

    for edge in graph["edges"]:
        assert set(edge) == {"source", "target"}
        assert edge["source"] in nodes and edge["target"] in nodes


async def test_graph_fuzzy_edge_resolved_and_broken_link_dropped(client):
    graph = (await client.get("/api/graph")).json()
    edges = {(e["source"], e["target"]) for e in graph["edges"]}

    # [[concepts/Attention_Mechanism]] resolves through the normalizer.
    assert ("concepts/sequence-modeling", "concepts/attention-mechanism") in edges
    # [[concepts/missing-page]] has no node and produces no edge.
    assert not any(t == "concepts/missing-page" for _, t in edges)

    attention = next(n for n in graph["nodes"] if n["id"] == "concepts/attention-mechanism")
    assert attention["in"] >= 3  # both summaries + sequence-modeling + entity


async def test_graph_cache_hit_and_invalidation_on_page_mtime_change(
    app, client, kb_dir: Path, monkeypatch
):
    first = (await client.get("/api/graph")).json()
    assert app.state.graph_cache is not None

    # Prove the cache is served: poison build_graph — an unchanged wiki must
    # still return the original graph.
    import openkb_web.routers.graph as graph_module

    sentinel = {"nodes": [], "edges": [], "types": ["SENTINEL"]}
    monkeypatch.setattr(graph_module, "build_graph", lambda wiki_dir: sentinel)

    second = (await client.get("/api/graph")).json()
    assert second == first

    # Bump one page's mtime (content unchanged, count unchanged) — the cache
    # key covers max page mtime, so this must trigger a recompute.
    page = kb_dir / "wiki" / "concepts" / "sequence-modeling.md"
    st = page.stat()
    os.utime(page, (st.st_atime + 100, st.st_mtime + 100))

    third = (await client.get("/api/graph")).json()
    assert third == sentinel


async def test_graph_recomputes_after_page_edit(client, kb_dir: Path):
    first = (await client.get("/api/graph")).json()
    edges = {(e["source"], e["target"]) for e in first["edges"]}
    assert ("concepts/sequence-modeling", "concepts/attention-mechanism") in edges

    # Drop the fuzzy link from the page and bump its mtime.
    page = kb_dir / "wiki" / "concepts" / "sequence-modeling.md"
    page.write_text(
        page.read_text(encoding="utf-8").replace("[[concepts/Attention_Mechanism]]", "attention"),
        encoding="utf-8",
    )
    st = page.stat()
    os.utime(page, (st.st_atime + 100, st.st_mtime + 100))

    second = (await client.get("/api/graph")).json()
    edges = {(e["source"], e["target"]) for e in second["edges"]}
    assert ("concepts/sequence-modeling", "concepts/attention-mechanism") not in edges


async def test_graph_picks_up_new_page(client, kb_dir: Path):
    assert len((await client.get("/api/graph")).json()["nodes"]) == 5

    (kb_dir / "wiki" / "entities" / "ashish-vaswani.md").write_text(
        '---\ntype: "Person"\ndescription: "Lead author."\n'
        'sources: ["summaries/demo-paper.md"]\n---\n\n'
        "# Ashish Vaswani\n\nSee [[concepts/attention-mechanism]].\n",
        encoding="utf-8",
    )

    graph = (await client.get("/api/graph")).json()
    assert len(graph["nodes"]) == 6
    assert "Person" in graph["types"]

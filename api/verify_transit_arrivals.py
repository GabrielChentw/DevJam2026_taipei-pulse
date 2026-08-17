"""Verify arrival fallback, provenance and optional live TDX enrichment."""

from __future__ import annotations

from app.data_sources import tdx_arrivals
from app.data_sources.tdx_bus import TDXBusShapeGeometry
from app.models import TransitArrivalSnapshot


ROUTES = (
    ("信義幹線", "TPE15708", 1, "TPE170429"),
    ("忠孝幹線", "TPE10417", 0, "TPE36064"),
)


def check(snapshot_raw: dict) -> TransitArrivalSnapshot:
    snapshot = TransitArrivalSnapshot.model_validate(snapshot_raw)
    assert snapshot.arrivals
    arrival = snapshot.arrivals[0]
    assert arrival.eta_seconds > 0
    assert arrival.suitable_for_wheelchair
    # TDX currently has no low-floor/ramp field. Never relabel simulation as official.
    assert arrival.accessibility_source == "demo_simulation"
    assert snapshot.notices
    return snapshot


def main() -> int:
    original_credentials = tdx_arrivals._credentials
    try:
        tdx_arrivals._credentials = lambda: ("", "")
        fallback = check(tdx_arrivals.load_transit_arrivals(*ROUTES[0], force_refresh=True))
        assert fallback.data_mode == "demo_fallback"
        print("[OK] offline arrival fallback and provenance")
    finally:
        tdx_arrivals._credentials = original_credentials

    if not TDXBusShapeGeometry().enabled:
        print("[SKIP] TDX credentials not configured; live arrival verification skipped")
        return 0

    for route in ROUTES:
        snapshot = check(tdx_arrivals.load_transit_arrivals(*route, force_refresh=True))
        arrival = snapshot.arrivals[0]
        print(
            f"[OK] {snapshot.route_name}: mode={snapshot.data_mode} "
            f"eta={arrival.eta_seconds}s timing={arrival.timing_source} "
            f"position={arrival.position_source} accessibility={arrival.accessibility_source}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

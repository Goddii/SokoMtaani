"""Unit conversion helpers for SokoMtaani."""


def to_base_unit(quantity: float, unit_sold_in: str, base_unit: str, avg_piece_weight: float | None) -> float:
    """
    Convert a sold quantity to the product's base_unit.

    Examples
    --------
    - Tomatoes (base_unit=kg, unit_sold_in=piece, avg_piece_weight=0.1):
        to_base_unit(5, "piece", "kg", 0.1) → 0.5 kg
    - Rice (base_unit=kg, unit_sold_in=kg):
        to_base_unit(2.5, "kg", "kg", None) → 2.5 kg
    - Carrier bags (base_unit=piece, unit_sold_in=piece):
        to_base_unit(10, "piece", "piece", None) → 10
    """
    if unit_sold_in == base_unit:
        return quantity

    # piece → kg  (e.g. tomatoes, onions sold per piece)
    if unit_sold_in == "piece" and base_unit == "kg":
        if not avg_piece_weight:
            raise ValueError(
                "avg_piece_weight is required for piece-to-kg conversion but is not set on this product."
            )
        return quantity * avg_piece_weight

    # kg → piece  (unusual but guard it)
    if unit_sold_in == "kg" and base_unit == "piece":
        if not avg_piece_weight:
            raise ValueError(
                "avg_piece_weight is required for kg-to-piece conversion but is not set on this product."
            )
        return quantity / avg_piece_weight

    # Any other combination: treat as same unit (1:1)
    return quantity


def bulk_to_base_unit(bulk_quantity: float, bulk_unit: str, base_unit: str) -> float:
    """
    Convert bulk purchase quantity to the product's base_unit.

    This is intentionally simple — most Kenyan small-retail purchases
    are already in the base unit (e.g. buying onions in kg, selling in kg).
    Complex conversions (bags→kg) are done by the user entering the
    correct base-unit quantity directly.

    If bulk_unit matches base_unit, quantity passes through unchanged.
    If they differ, we assume the caller has already done the conversion
    (or will rely on the cost_per_base_unit being computed as
    total_cost / bulk_quantity, where bulk_quantity is stated in base_unit).
    """
    # For now, treat all bulk units as equivalent to base_unit.
    # Extend this function for more complex conversions if needed.
    return bulk_quantity

"""Generate Summit Outfitters test invoice PDFs from real Snowflake orders.

Three sets, written under test_invoices/:
  matching/    invoices that agree exactly with ORDERS / ORDER_ITEMS
  mismatched/  real orders with one deliberate discrepancy each
  new/         orders that do not exist yet (ORDER_ID > max) -> created on approval

Run from the repo root:
  uv run --with reportlab --with snowflake-connector-python \
    scripts/generate_invoices.py --connection osm_deploy
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import snowflake.connector
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

SCHEMA = "SNOWFLAKE_DEMO.CORTEX_SENSE"
OUT = Path(__file__).resolve().parent.parent / "test_invoices"
CENT = Decimal("0.01")
BRAND = colors.HexColor("#1F4E3D")


def money(v) -> Decimal:
    return Decimal(str(v)).quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass
class Line:
    line_number: int
    sku: str
    description: str
    quantity: int
    unit_price: Decimal
    discount: Decimal

    @property
    def gross(self) -> Decimal:
        return money(self.unit_price * self.quantity)

    @property
    def amount(self) -> Decimal:
        return money(self.gross - self.discount)


@dataclass
class Invoice:
    order_id: int
    order_date: dt.date
    customer_name: str
    customer_email: str
    store_name: str
    shipping: Decimal
    lines: list[Line] = field(default_factory=list)
    invoice_date: dt.date | None = None

    @property
    def invoice_number(self) -> str:
        return f"INV-{self.order_date.year}-{self.order_id:06d}"

    @property
    def subtotal(self) -> Decimal:
        return money(sum((l.gross for l in self.lines), Decimal(0)))

    @property
    def discount(self) -> Decimal:
        return money(sum((l.discount for l in self.lines), Decimal(0)))

    @property
    def total(self) -> Decimal:
        return money(self.subtotal - self.discount + self.shipping)


# ---------------------------------------------------------------------------
# Snowflake reads
# ---------------------------------------------------------------------------
ORDER_PICK_SQL = f"""
SELECT o.ORDER_ID
FROM {SCHEMA}.ORDERS o
WHERE o.ORDER_STATUS = 'DELIVERED' AND o.IS_TEST_ORDER = FALSE
  AND o.CUSTOMER_ID IS NOT NULL
  AND o.ORDER_DATE >= '2026-08-01'
  AND (SELECT COUNT(*) FROM {SCHEMA}.ORDER_ITEMS i WHERE i.ORDER_ID = o.ORDER_ID) BETWEEN 2 AND 4
ORDER BY o.ORDER_ID
LIMIT %(n)s
"""

ORDER_DETAIL_SQL = f"""
SELECT o.ORDER_ID, o.ORDER_DATE, c.FIRST_NAME || ' ' || c.LAST_NAME AS CUSTOMER_NAME, c.EMAIL,
       s.STORE_NAME, o.SHIPPING_USD, i.LINE_NUMBER, p.SKU, p.PRODUCT_NAME, i.QUANTITY,
       i.UNIT_PRICE, i.DISCOUNT_AMOUNT
FROM {SCHEMA}.ORDERS o
JOIN {SCHEMA}.CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
JOIN {SCHEMA}.STORES s ON s.STORE_ID = o.STORE_ID
JOIN {SCHEMA}.ORDER_ITEMS i ON i.ORDER_ID = o.ORDER_ID
JOIN {SCHEMA}.PRODUCTS p ON p.PRODUCT_ID = i.PRODUCT_ID
WHERE o.ORDER_ID = %(order_id)s
ORDER BY i.LINE_NUMBER
"""


def load_invoice(cur, order_id: int) -> Invoice:
    rows = cur.execute(ORDER_DETAIL_SQL, {"order_id": order_id}).fetchall()
    first = rows[0]
    inv = Invoice(
        order_id=first[0], order_date=first[1], customer_name=first[2], customer_email=first[3],
        store_name=first[4], shipping=money(first[5]), invoice_date=first[1],
    )
    for r in rows:
        inv.lines.append(Line(r[6], r[7], r[8], int(r[9]), money(r[10]), money(r[11])))
    return inv


def products_by_sku(cur, skus: list[str]) -> dict[str, tuple[str, Decimal]]:
    rows = cur.execute(
        f"SELECT SKU, PRODUCT_NAME, LIST_PRICE FROM {SCHEMA}.PRODUCTS WHERE SKU IN ({','.join(['%s'] * len(skus))})",
        skus,
    ).fetchall()
    return {r[0]: (r[1], money(r[2])) for r in rows}


def customer(cur, customer_id: int) -> tuple[str, str]:
    r = cur.execute(
        f"SELECT FIRST_NAME || ' ' || LAST_NAME, EMAIL FROM {SCHEMA}.CUSTOMERS WHERE CUSTOMER_ID = %s",
        (customer_id,),
    ).fetchone()
    return r[0], r[1]


# ---------------------------------------------------------------------------
# PDF rendering
# ---------------------------------------------------------------------------
def render(inv: Invoice, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    h_brand = ParagraphStyle("brand", parent=styles["Title"], textColor=BRAND, alignment=0, fontSize=22, spaceAfter=2)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=9, leading=12, textColor=colors.HexColor("#444444"))
    right = ParagraphStyle("right", parent=small, alignment=TA_RIGHT)
    label = ParagraphStyle("label", parent=small, fontName="Helvetica-Bold", textColor=BRAND)

    doc = SimpleDocTemplate(str(path), pagesize=LETTER, leftMargin=0.7 * inch, rightMargin=0.7 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch,
                            title=f"Invoice {inv.invoice_number}", author="Summit Outfitters")
    story = []

    header = Table(
        [[Paragraph("Summit Outfitters", h_brand),
          Paragraph("<font size=18><b>INVOICE</b></font>", ParagraphStyle("inv", parent=right, textColor=BRAND))],
         [Paragraph("1200 Basecamp Way, Denver, CO 80202<br/>billing@summitoutfitters.example", small), ""]],
        colWidths=[4.3 * inch, 2.8 * inch],
    )
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
    story += [header, Spacer(1, 14)]

    meta = Table(
        [
            [Paragraph("BILL TO", label), Paragraph("INVOICE DETAILS", label)],
            [Paragraph(f"{inv.customer_name}<br/>{inv.customer_email}", small),
             Paragraph(
                 f"Invoice Number: <b>{inv.invoice_number}</b><br/>"
                 f"Invoice Date: {inv.invoice_date:%Y-%m-%d}<br/>"
                 f"Order Number: <b>{inv.order_id}</b><br/>"
                 f"Order Date: {inv.order_date:%Y-%m-%d}<br/>"
                 f"Store: {inv.store_name}", small)],
        ],
        colWidths=[3.55 * inch, 3.55 * inch],
    )
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, BRAND),
        ("TOPPADDING", (0, 1), (-1, 1), 6),
    ]))
    story += [meta, Spacer(1, 18)]

    rows = [["Line", "SKU", "Description", "Qty", "Unit Price", "Discount", "Amount"]]
    for l in inv.lines:
        rows.append([str(l.line_number), l.sku, Paragraph(l.description, small), str(l.quantity),
                     f"${l.unit_price:,.2f}", f"${l.discount:,.2f}", f"${l.amount:,.2f}"])
    items = Table(rows, colWidths=[0.45 * inch, 0.95 * inch, 2.45 * inch, 0.5 * inch, 0.95 * inch, 0.85 * inch, 0.95 * inch],
                  repeatRows=1)
    items.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F6F4")]),
        ("LINEBELOW", (0, -1), (-1, -1), 0.5, colors.HexColor("#BBBBBB")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story += [items, Spacer(1, 12)]

    totals = Table(
        [["Subtotal", f"${inv.subtotal:,.2f}"],
         ["Discount", f"-${inv.discount:,.2f}"],
         ["Shipping", f"${inv.shipping:,.2f}"],
         ["Total Due", f"${inv.total:,.2f}"]],
        colWidths=[1.3 * inch, 1.2 * inch], hAlign="RIGHT",
    )
    totals.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 1, BRAND),
        ("TEXTCOLOR", (0, -1), (-1, -1), BRAND),
    ]))
    story += [totals, Spacer(1, 28),
              Paragraph("Payment terms: Net 30. Thank you for shopping with Summit Outfitters.", small)]
    doc.build(story)


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection", default="osm_deploy")
    args = ap.parse_args()

    expected: list[tuple[str, str, str]] = []
    with snowflake.connector.connect(connection_name=args.connection) as conn, conn.cursor() as cur:
        order_ids = [r[0] for r in cur.execute(ORDER_PICK_SQL, {"n": 11}).fetchall()]
        invoices = [load_invoice(cur, oid) for oid in order_ids]
        max_order = cur.execute(f"SELECT MAX(ORDER_ID) FROM {SCHEMA}.ORDERS").fetchone()[0]

        # -- matching: exact copies ------------------------------------------------
        for inv in invoices[:5]:
            render(inv, OUT / "matching" / f"{inv.invoice_number}.pdf")
            expected.append((f"matching/{inv.invoice_number}.pdf", "MATCHED", f"Exact copy of order {inv.order_id}"))

        # -- mismatched: one injected discrepancy each ------------------------------
        mm = [copy.deepcopy(i) for i in invoices[5:11]]

        mm[0].lines[0].quantity += 1
        mm[0].lines[0].discount = money(mm[0].lines[0].discount / (mm[0].lines[0].quantity - 1) * mm[0].lines[0].quantity)
        note0 = f"Line 1 quantity {mm[0].lines[0].quantity - 1} -> {mm[0].lines[0].quantity}"

        mm[1].lines[1].unit_price = money(mm[1].lines[1].unit_price + Decimal("10.00"))
        note1 = f"Line 2 unit price +$10.00 (now ${mm[1].lines[1].unit_price})"

        dropped = mm[2].lines.pop()
        note2 = f"Line {dropped.line_number} ({dropped.sku}) missing from invoice"

        extra_sku = "SKU-00150"
        name, price = products_by_sku(cur, [extra_sku])[extra_sku]
        mm[3].lines.append(Line(len(mm[3].lines) + 1, extra_sku, name, 1, price, Decimal("0.00")))
        note3 = f"Extra line {len(mm[3].lines)} ({extra_sku}, ${price}) not on the order"

        mm[4].shipping = money(mm[4].shipping + Decimal("7.50"))
        note4 = f"Shipping +$7.50 (now ${mm[4].shipping})"

        wrong_name, wrong_email = customer(cur, 4242)
        note5 = f"Bill-to email {mm[5].customer_email} -> {wrong_email}"
        mm[5].customer_name, mm[5].customer_email = wrong_name, wrong_email

        for inv, note in zip(mm, [note0, note1, note2, note3, note4, note5]):
            render(inv, OUT / "mismatched" / f"{inv.invoice_number}.pdf")
            expected.append((f"mismatched/{inv.invoice_number}.pdf", "MISMATCHED", note))

        # -- new: orders that do not exist yet --------------------------------------
        new_specs = [
            # (customer_id, store, date, [(sku, qty, discount_pct)], shipping)
            (1207, "Summit Online", "2026-11-04", [("SKU-00012", 2, 0), ("SKU-00118", 1, 0)], "9.00"),
            (3315, "Summit Denver", "2026-11-05", [("SKU-00041", 1, 10), ("SKU-00076", 3, 0), ("SKU-00190", 1, 0)], "0.00"),
            (5530, "Summit Seattle", "2026-11-06", [("SKU-00205", 1, 0), ("SKU-00099", 2, 10)], "12.00"),
            (7781, "Summit Boulder", "2026-11-07", [("SKU-00112", 1, 0), ("SKU-00163", 2, 0)], "6.00"),
        ]
        all_skus = sorted({s for spec in new_specs for s, _, _ in spec[3]})
        catalog = products_by_sku(cur, all_skus)
        for n, (cust_id, store, day, items, ship) in enumerate(new_specs, start=1):
            cname, cemail = customer(cur, cust_id)
            d = dt.date.fromisoformat(day)
            inv = Invoice(order_id=max_order + n, order_date=d, invoice_date=d, customer_name=cname,
                          customer_email=cemail, store_name=store, shipping=money(ship))
            for ln, (sku, qty, pct) in enumerate(items, start=1):
                pname, price = catalog[sku]
                inv.lines.append(Line(ln, sku, pname, qty, price, money(price * qty * pct / 100)))
            note = f"New order {inv.order_id} for {cemail} at {store}"
            if n == 4:
                # Typo the reviewer must fix before approval: letter O instead of zero.
                inv.lines[0].sku = "SKU-0O112"
                note += "; line 1 SKU printed as SKU-0O112 (letter O) - correct to SKU-00112 in review"
            render(inv, OUT / "new" / f"{inv.invoice_number}.pdf")
            expected.append((f"new/{inv.invoice_number}.pdf", "NEW", note))

    lines = ["# Expected results", "",
             "Generated by `scripts/generate_invoices.py` from live `SNOWFLAKE_DEMO.CORTEX_SENSE` data.", "",
             "| File | Expected status | What to look for |", "| --- | --- | --- |"]
    lines += [f"| `{f}` | {s} | {n} |" for f, s, n in expected]
    (OUT / "EXPECTED_RESULTS.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

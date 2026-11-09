/* =====================================================================
   02 — Stage + invoice tables
   ---------------------------------------------------------------------
   Owned by SYSADMIN (the schema owner); the app role gets DML.
   AI_EXTRACT requires server-side encryption on internal stages.
   Idempotent (CREATE ... IF NOT EXISTS) so re-running never drops data.
   ===================================================================== */
USE ROLE SYSADMIN;
USE SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE;

CREATE STAGE IF NOT EXISTS INVOICE_STAGE
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY  = (ENABLE = TRUE)
  COMMENT    = 'Uploaded invoice PDFs for the Invoice Reconciliation app. Path: <uuid>/<file>.pdf';

CREATE TABLE IF NOT EXISTS INVOICES (
  INVOICE_ID         VARCHAR       NOT NULL COMMENT 'Primary key (UUID)',
  INVOICE_NUMBER     VARCHAR       NOT NULL COMMENT 'Vendor invoice number printed on the PDF, e.g. INV-2026-000101. Unique',
  ORDER_ID           NUMBER                 COMMENT 'Order number on the invoice. FK to ORDERS.ORDER_ID (for NEW invoices the order is created on approval)',
  INVOICE_DATE       DATE,
  ORDER_DATE         DATE,
  CUSTOMER_NAME      VARCHAR,
  CUSTOMER_EMAIL     VARCHAR,
  CUSTOMER_ID        NUMBER                 COMMENT 'Resolved CUSTOMERS.CUSTOMER_ID (via email)',
  STORE_NAME         VARCHAR,
  STORE_ID           NUMBER                 COMMENT 'Resolved STORES.STORE_ID (via store name)',
  SUBTOTAL_USD       NUMBER(12,2)           COMMENT 'Sum of line gross amounts (qty * unit price) as printed',
  DISCOUNT_USD       NUMBER(12,2)           COMMENT 'Total discount as printed',
  SHIPPING_USD       NUMBER(12,2)           COMMENT 'Shipping as printed; not revenue',
  TOTAL_USD          NUMBER(12,2)           COMMENT 'Invoice total as printed = subtotal - discount + shipping',
  MATCH_STATUS       VARCHAR       NOT NULL COMMENT 'MATCHED = invoice agrees with ORDERS/ORDER_ITEMS; MISMATCHED = order exists but differs; NEW = order did not exist and was created on approval',
  DISCREPANCY_COUNT  NUMBER        NOT NULL DEFAULT 0,
  VARIANCE_USD       NUMBER(12,2)           COMMENT 'Invoice total minus Snowflake expected total (NULL for NEW)',
  FILE_NAME          VARCHAR,
  FILE_PATH          VARCHAR                COMMENT 'Relative path on @INVOICE_STAGE',
  EXTRACTED_JSON     VARIANT                COMMENT 'Raw AI_EXTRACT output (response + scoring) before human edits',
  EDITED_FIELDS      ARRAY                  COMMENT 'Fields the reviewer changed before approval',
  ORDER_CREATED      BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'TRUE when approval inserted a new ORDERS/ORDER_ITEMS record',
  APPROVED_BY        VARCHAR,
  APPROVED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  CONSTRAINT PK_INVOICES PRIMARY KEY (INVOICE_ID),
  CONSTRAINT UQ_INVOICE_NUMBER UNIQUE (INVOICE_NUMBER)
) COMMENT = 'Approved vendor invoices ingested from PDF via AI_EXTRACT. Grain: invoice. Reconciled against ORDERS.';

CREATE TABLE IF NOT EXISTS INVOICE_LINES (
  INVOICE_ID       VARCHAR      NOT NULL COMMENT 'FK to INVOICES',
  LINE_NUMBER      NUMBER       NOT NULL,
  SKU              VARCHAR               COMMENT 'Product SKU as printed; FK to PRODUCTS.SKU',
  PRODUCT_ID       NUMBER,
  DESCRIPTION      VARCHAR,
  QUANTITY         NUMBER,
  UNIT_PRICE       NUMBER(10,2),
  DISCOUNT_AMOUNT  NUMBER(10,2),
  LINE_AMOUNT      NUMBER(12,2)          COMMENT 'Net line amount as printed = qty * unit price - discount',
  LINE_STATUS      VARCHAR               COMMENT 'MATCHED, MISMATCHED, EXTRA (not on the order), MISSING (on the order, not on the invoice), NEW',
  CONSTRAINT PK_INVOICE_LINES PRIMARY KEY (INVOICE_ID, LINE_NUMBER)
) COMMENT = 'Invoice line items. Grain: invoice line.';

CREATE TABLE IF NOT EXISTS INVOICE_DISCREPANCIES (
  DISCREPANCY_ID   VARCHAR NOT NULL DEFAULT UUID_STRING(),
  INVOICE_ID       VARCHAR NOT NULL COMMENT 'FK to INVOICES',
  SCOPE            VARCHAR NOT NULL COMMENT 'HEADER or LINE',
  LINE_NUMBER      NUMBER,
  FIELD_NAME       VARCHAR NOT NULL COMMENT 'e.g. quantity, unit_price, shipping_usd, total_usd, customer_email, line (missing/extra)',
  INVOICE_VALUE    VARCHAR,
  SNOWFLAKE_VALUE  VARCHAR,
  DIFFERENCE_USD   NUMBER(12,2) COMMENT 'Dollar impact where numeric (invoice - snowflake)',
  CONSTRAINT PK_INVOICE_DISCREPANCIES PRIMARY KEY (DISCREPANCY_ID)
) COMMENT = 'Field-level differences between an invoice and ORDERS/ORDER_ITEMS at approval time. Grain: discrepancy.';

GRANT READ, WRITE ON STAGE INVOICE_STAGE TO ROLE INVOICE_APP_ROLE;
GRANT SELECT, INSERT ON TABLE INVOICES              TO ROLE INVOICE_APP_ROLE;
GRANT SELECT, INSERT ON TABLE INVOICE_LINES         TO ROLE INVOICE_APP_ROLE;
GRANT SELECT, INSERT ON TABLE INVOICE_DISCREPANCIES TO ROLE INVOICE_APP_ROLE;

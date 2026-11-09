/* =====================================================================
   03 — Stored procedures called by the app
   ---------------------------------------------------------------------
   Both run EXECUTE AS OWNER (SYSADMIN) so the app role needs only USAGE
   on the procedures — not INSERT on ORDERS / ORDER_ITEMS.
   ===================================================================== */
USE ROLE SYSADMIN;
USE SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE;

-- ---------------------------------------------------------------------
-- UPLOAD_INVOICE: write a base64 PDF to @INVOICE_STAGE under a unique
-- prefix and return the relative path. Uploading through a procedure
-- keeps the app container from needing direct egress to stage storage.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE UPLOAD_INVOICE(FILE_NAME VARCHAR, CONTENT_B64 VARCHAR)
RETURNS VARCHAR
LANGUAGE PYTHON
RUNTIME_VERSION = '3.12'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'main'
COMMENT = 'Invoice app: store an uploaded PDF on @INVOICE_STAGE; returns <uuid>/<file>.pdf'
EXECUTE AS OWNER
AS
$$
import base64
import io
import re
import uuid

from snowflake.snowpark import Session

STAGE = "@SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_STAGE"
MAX_BYTES = 10 * 1024 * 1024


def main(session: Session, file_name: str, content_b64: str) -> str:
    data = base64.b64decode(content_b64 or "", validate=True)
    if not data.startswith(b"%PDF-"):
        raise ValueError("File is not a PDF")
    if len(data) > MAX_BYTES:
        raise ValueError("PDF exceeds the 10 MB limit")

    # Only safe characters reach the stage path (no traversal, no quoting issues).
    base = re.sub(r"[^A-Za-z0-9._-]", "_", (file_name or "").rsplit("/", 1)[-1])[:120].strip("._")
    if not base:
        base = "invoice"
    if not base.lower().endswith(".pdf"):
        base += ".pdf"

    rel_path = f"{uuid.uuid4().hex}/{base}"
    session.file.put_stream(io.BytesIO(data), f"{STAGE}/{rel_path}", auto_compress=False, overwrite=False)
    return rel_path
$$;

-- ---------------------------------------------------------------------
-- APPROVE_INVOICE: persist a reviewed invoice in one transaction.
--   * rejects a duplicate INVOICE_NUMBER
--   * if the order does not exist -> status NEW, resolve customer (email),
--     store (name), products (SKU) and insert ORDERS + ORDER_ITEMS
--   * writes INVOICES, INVOICE_LINES, INVOICE_DISCREPANCIES
-- Returns {ok, invoice_id, match_status, order_created} or {ok:false, errors[]}.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE APPROVE_INVOICE(PAYLOAD VARIANT)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = 'Invoice app: approve a reviewed invoice; creates ORDERS/ORDER_ITEMS for new orders'
EXECUTE AS OWNER
AS
$$
DECLARE
  v_invoice_id    VARCHAR DEFAULT UUID_STRING();
  v_inv_no        VARCHAR;
  v_order_id      NUMBER;
  v_order_date    DATE;
  v_email         VARCHAR;
  v_store         VARCHAR;
  v_shipping      NUMBER(12,2);
  v_status        VARCHAR;
  v_lines         VARIANT;
  v_disc          VARIANT;
  v_edited        VARIANT;
  v_errors        ARRAY DEFAULT ARRAY_CONSTRUCT();
  v_dup           NUMBER DEFAULT 0;
  v_order_exists  NUMBER DEFAULT 0;
  v_customer_id   NUMBER;
  v_store_id      NUMBER;
  v_line_count    NUMBER DEFAULT 0;
  v_missing_skus  ARRAY;
  v_create_order  BOOLEAN DEFAULT FALSE;
BEGIN
  v_inv_no     := NULLIF(TRIM(PAYLOAD:invoice_number::VARCHAR), '');
  v_order_id   := TRY_TO_NUMBER(PAYLOAD:order_id::VARCHAR);
  v_order_date := TRY_TO_DATE(PAYLOAD:order_date::VARCHAR);
  v_email      := NULLIF(TRIM(PAYLOAD:customer_email::VARCHAR), '');
  v_store      := NULLIF(TRIM(PAYLOAD:store_name::VARCHAR), '');
  v_shipping   := COALESCE(TRY_TO_NUMBER(PAYLOAD:shipping_usd::VARCHAR, 12, 2), 0);
  v_status     := UPPER(PAYLOAD:match_status::VARCHAR);
  v_lines      := COALESCE(PAYLOAD:lines, ARRAY_CONSTRUCT()::VARIANT);
  v_disc       := COALESCE(PAYLOAD:discrepancies, ARRAY_CONSTRUCT()::VARIANT);
  v_edited     := COALESCE(PAYLOAD:edited_fields, ARRAY_CONSTRUCT()::VARIANT);

  IF (v_inv_no IS NULL) THEN
    v_errors := ARRAY_APPEND(v_errors, 'invoice_number: required');
  END IF;
  IF (v_order_id IS NULL) THEN
    v_errors := ARRAY_APPEND(v_errors, 'order_id: required and must be a number');
  END IF;
  IF (ARRAY_SIZE(v_errors) > 0) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'errors', v_errors);
  END IF;

  SELECT COUNT(*) INTO :v_dup FROM INVOICES WHERE INVOICE_NUMBER = :v_inv_no;
  IF (v_dup > 0) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'errors',
      ARRAY_CONSTRUCT('invoice_number: ' || v_inv_no || ' has already been approved'));
  END IF;

  SELECT COUNT(*) INTO :v_order_exists FROM ORDERS WHERE ORDER_ID = :v_order_id;
  SELECT MAX(CUSTOMER_ID) INTO :v_customer_id FROM CUSTOMERS WHERE EMAIL ILIKE :v_email;
  SELECT MAX(STORE_ID)    INTO :v_store_id    FROM STORES    WHERE STORE_NAME ILIKE :v_store;
  SELECT COUNT(*) INTO :v_line_count FROM TABLE(FLATTEN(INPUT => :v_lines));

  IF (v_order_exists = 0) THEN
    -- New order: every reference must resolve before anything is written.
    v_status := 'NEW';
    v_create_order := TRUE;
    IF (v_order_date IS NULL) THEN
      v_errors := ARRAY_APPEND(v_errors, 'order_date: required for a new order');
    END IF;
    IF (v_email IS NOT NULL AND v_customer_id IS NULL) THEN
      v_errors := ARRAY_APPEND(v_errors, 'customer_email: no customer with email ' || v_email);
    END IF;
    IF (v_store_id IS NULL) THEN
      v_errors := ARRAY_APPEND(v_errors, 'store_name: no store named ' || COALESCE(v_store, '(blank)'));
    END IF;
    IF (v_line_count = 0) THEN
      v_errors := ARRAY_APPEND(v_errors, 'lines: a new order needs at least one line');
    END IF;
    SELECT ARRAY_AGG(COALESCE(f.value:sku::VARCHAR, '(blank)')) INTO :v_missing_skus
      FROM TABLE(FLATTEN(INPUT => :v_lines)) f
      LEFT JOIN PRODUCTS p ON p.SKU = UPPER(TRIM(f.value:sku::VARCHAR))
     WHERE p.PRODUCT_ID IS NULL;
    IF (ARRAY_SIZE(v_missing_skus) > 0) THEN
      v_errors := ARRAY_APPEND(v_errors, 'sku: unknown product SKU(s) ' || ARRAY_TO_STRING(v_missing_skus, ', '));
    END IF;
    IF (ARRAY_SIZE(v_errors) > 0) THEN
      RETURN OBJECT_CONSTRUCT('ok', FALSE, 'errors', v_errors);
    END IF;
  ELSEIF (v_status NOT IN ('MATCHED', 'MISMATCHED')) THEN
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'errors',
      ARRAY_CONSTRUCT('order_id: order ' || v_order_id || ' already exists; re-run the comparison before approving'));
  END IF;

  BEGIN TRANSACTION;

  IF (v_create_order) THEN
    INSERT INTO ORDERS (ORDER_ID, CUSTOMER_ID, STORE_ID, CAMPAIGN_ID, ORDER_TS, ORDER_DATE,
                        ORDER_STATUS, IS_TEST_ORDER, SHIPPING_USD)
    VALUES (:v_order_id, :v_customer_id, :v_store_id, NULL, :v_order_date::TIMESTAMP_NTZ, :v_order_date,
            'PLACED', FALSE, :v_shipping);

    INSERT INTO ORDER_ITEMS (ORDER_ID, LINE_NUMBER, PRODUCT_ID, QUANTITY, UNIT_PRICE, DISCOUNT_AMOUNT, GROSS_SALES)
    SELECT :v_order_id,
           COALESCE(TRY_TO_NUMBER(f.value:line_number::VARCHAR), f.index + 1),
           p.PRODUCT_ID,
           TRY_TO_NUMBER(f.value:quantity::VARCHAR),
           TRY_TO_NUMBER(f.value:unit_price::VARCHAR, 10, 2),
           COALESCE(TRY_TO_NUMBER(f.value:discount_amount::VARCHAR, 10, 2), 0),
           ROUND(TRY_TO_NUMBER(f.value:quantity::VARCHAR) * TRY_TO_NUMBER(f.value:unit_price::VARCHAR, 10, 2), 2)
      FROM TABLE(FLATTEN(INPUT => :v_lines)) f
      JOIN PRODUCTS p ON p.SKU = UPPER(TRIM(f.value:sku::VARCHAR));
  END IF;

  INSERT INTO INVOICES (INVOICE_ID, INVOICE_NUMBER, ORDER_ID, INVOICE_DATE, ORDER_DATE, CUSTOMER_NAME,
                        CUSTOMER_EMAIL, CUSTOMER_ID, STORE_NAME, STORE_ID, SUBTOTAL_USD, DISCOUNT_USD,
                        SHIPPING_USD, TOTAL_USD, MATCH_STATUS, DISCREPANCY_COUNT, VARIANCE_USD, FILE_NAME,
                        FILE_PATH, EXTRACTED_JSON, EDITED_FIELDS, ORDER_CREATED, APPROVED_BY)
  SELECT :v_invoice_id, :v_inv_no, :v_order_id,
         TRY_TO_DATE(:PAYLOAD:invoice_date::VARCHAR), :v_order_date,
         :PAYLOAD:customer_name::VARCHAR, :v_email, :v_customer_id, :v_store, :v_store_id,
         TRY_TO_NUMBER(:PAYLOAD:subtotal_usd::VARCHAR, 12, 2),
         TRY_TO_NUMBER(:PAYLOAD:discount_usd::VARCHAR, 12, 2),
         :v_shipping,
         TRY_TO_NUMBER(:PAYLOAD:total_usd::VARCHAR, 12, 2),
         :v_status,
         ARRAY_SIZE(:v_disc::ARRAY),
         IFF(:v_status = 'NEW', NULL, TRY_TO_NUMBER(:PAYLOAD:variance_usd::VARCHAR, 12, 2)),
         :PAYLOAD:file_name::VARCHAR, :PAYLOAD:file_path::VARCHAR,
         :PAYLOAD:extracted_json, :v_edited::ARRAY, :v_create_order,
         COALESCE(:PAYLOAD:approved_by::VARCHAR, CURRENT_USER());

  INSERT INTO INVOICE_LINES (INVOICE_ID, LINE_NUMBER, SKU, PRODUCT_ID, DESCRIPTION, QUANTITY, UNIT_PRICE,
                             DISCOUNT_AMOUNT, LINE_AMOUNT, LINE_STATUS)
  SELECT :v_invoice_id,
         COALESCE(TRY_TO_NUMBER(f.value:line_number::VARCHAR), f.index + 1),
         UPPER(TRIM(f.value:sku::VARCHAR)),
         p.PRODUCT_ID,
         f.value:description::VARCHAR,
         TRY_TO_NUMBER(f.value:quantity::VARCHAR),
         TRY_TO_NUMBER(f.value:unit_price::VARCHAR, 10, 2),
         TRY_TO_NUMBER(f.value:discount_amount::VARCHAR, 10, 2),
         TRY_TO_NUMBER(f.value:line_amount::VARCHAR, 12, 2),
         IFF(:v_status = 'NEW', 'NEW', UPPER(f.value:line_status::VARCHAR))
    FROM TABLE(FLATTEN(INPUT => :v_lines)) f
    LEFT JOIN PRODUCTS p ON p.SKU = UPPER(TRIM(f.value:sku::VARCHAR));

  INSERT INTO INVOICE_DISCREPANCIES (INVOICE_ID, SCOPE, LINE_NUMBER, FIELD_NAME, INVOICE_VALUE,
                                     SNOWFLAKE_VALUE, DIFFERENCE_USD)
  SELECT :v_invoice_id,
         UPPER(COALESCE(f.value:scope::VARCHAR, 'HEADER')),
         TRY_TO_NUMBER(f.value:line_number::VARCHAR),
         f.value:field_name::VARCHAR,
         f.value:invoice_value::VARCHAR,
         f.value:snowflake_value::VARCHAR,
         TRY_TO_NUMBER(f.value:difference_usd::VARCHAR, 12, 2)
    FROM TABLE(FLATTEN(INPUT => :v_disc)) f;

  COMMIT;

  RETURN OBJECT_CONSTRUCT('ok', TRUE, 'invoice_id', v_invoice_id, 'match_status', v_status,
                          'order_created', v_create_order, 'order_id', v_order_id);
EXCEPTION
  WHEN OTHER THEN
    ROLLBACK;
    RETURN OBJECT_CONSTRUCT('ok', FALSE, 'errors', ARRAY_CONSTRUCT('approval failed: ' || SQLERRM));
END;
$$;

GRANT USAGE ON PROCEDURE UPLOAD_INVOICE(VARCHAR, VARCHAR) TO ROLE INVOICE_APP_ROLE;
GRANT USAGE ON PROCEDURE APPROVE_INVOICE(VARIANT)         TO ROLE INVOICE_APP_ROLE;

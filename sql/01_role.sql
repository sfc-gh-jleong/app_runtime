/* =====================================================================
   01 — Dedicated owner role for the Invoice Reconciliation app
   ---------------------------------------------------------------------
   The role that deploys an APPLICATION SERVICE becomes its execution
   role and cannot be changed afterwards, so the app gets its own role
   instead of SYSADMIN. Run as ACCOUNTADMIN (or SECURITYADMIN + SYSADMIN).
   Idempotent.
   ===================================================================== */
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS INVOICE_APP_ROLE
  COMMENT = 'Owns and runs the Invoice Reconciliation SAR app (SNOWFLAKE_DEMO.CORTEX_SENSE)';
GRANT ROLE INVOICE_APP_ROLE TO ROLE SYSADMIN;
GRANT ROLE INVOICE_APP_ROLE TO USER JLEONG;

USE ROLE SYSADMIN;
GRANT USAGE ON DATABASE SNOWFLAKE_DEMO                 TO ROLE INVOICE_APP_ROLE;
GRANT USAGE ON SCHEMA   SNOWFLAKE_DEMO.CORTEX_SENSE    TO ROLE INVOICE_APP_ROLE;
GRANT USAGE ON WAREHOUSE COMPUTE_WH                    TO ROLE INVOICE_APP_ROLE;

-- Read the Summit Outfitters source data (reconciliation + agent)
GRANT SELECT ON ALL TABLES    IN SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE TO ROLE INVOICE_APP_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE TO ROLE INVOICE_APP_ROLE;

-- Deploy the application service into this schema
GRANT CREATE APPLICATION SERVICE  ON SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE TO ROLE INVOICE_APP_ROLE;
GRANT CREATE ARTIFACT REPOSITORY  ON SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE TO ROLE INVOICE_APP_ROLE;
GRANT CREATE STAGE                ON SCHEMA SNOWFLAKE_DEMO.CORTEX_SENSE TO ROLE INVOICE_APP_ROLE;

-- Build-time npm egress (npm ci runs inside Snowflake during the image build)
USE ROLE ACCOUNTADMIN;
GRANT USAGE ON INTEGRATION GHA_APP_NPM_EAI TO ROLE INVOICE_APP_ROLE;

-- Cortex: AI_EXTRACT + agent (CORTEX_USER is also on PUBLIC; granted explicitly so
-- the app keeps working if an admin revokes it from PUBLIC)
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER       TO ROLE INVOICE_APP_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_SENSE_USER TO ROLE INVOICE_APP_ROLE;

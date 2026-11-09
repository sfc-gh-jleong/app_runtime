/* =====================================================================
   04 — Semantic view INVOICE_RECON_SV (agent's invoice analyst tool)
   ---------------------------------------------------------------------
   Source of truth: cortex_project/INVOICE_RECON_SV.sv.yaml
   Redeploy after editing the YAML with either:
     cortex agent-studio sv-deploy --file-path cortex_project/INVOICE_RECON_SV.sv.yaml \
       --fqn SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECON_SV
   or
     CALL SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML('SNOWFLAKE_DEMO.CORTEX_SENSE', $$<yaml>$$);
   Then run the grants below (a re-create drops existing grants).
   ===================================================================== */
USE ROLE SYSADMIN;
GRANT REFERENCES, SELECT ON SEMANTIC VIEW SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECON_SV TO ROLE INVOICE_APP_ROLE;

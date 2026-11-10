/* =====================================================================
   05 — SUMMIT_RETAIL_AGENT: add the invoice_reconciliation analyst tool
   ---------------------------------------------------------------------
   Spec source of truth: cortex_project/SUMMIT_RETAIL_AGENT.agent.yaml
   Apply a spec change as a new version (keeps version history):
     cortex agent-studio agent-save --file-path SUMMIT_RETAIL_AGENT.agent.yaml \
       --fqn SNOWFLAKE_DEMO.CORTEX_SENSE.SUMMIT_RETAIL_AGENT
     cortex agent-studio agent-publish --fqn SNOWFLAKE_DEMO.CORTEX_SENSE.SUMMIT_RETAIL_AGENT
   VERSION$1 = original retail-only spec; VERSION$2 = + invoice_reconciliation;
   VERSION$3 = + retail_sales analyst tool over RETAIL_SALES_SV (retail answers
   without the generic SQL step, which fails under the app's service identity).
   Grants below let the app role (which runs the chat) use the agent and
   every tool it calls.
   ===================================================================== */
USE ROLE SYSADMIN;
GRANT USAGE ON AGENT SNOWFLAKE_DEMO.CORTEX_SENSE.SUMMIT_RETAIL_AGENT TO ROLE INVOICE_APP_ROLE;
GRANT REFERENCES, SELECT ON SEMANTIC VIEW SNOWFLAKE_DEMO.CORTEX_SENSE.RETAIL_SALES_SV TO ROLE INVOICE_APP_ROLE;

-- Context name is case-sensitive; needs a role holding CORTEX_SENSE_BUILDER/owner.
USE ROLE ACCOUNTADMIN;
GRANT USAGE ON CORTEX SENSE SNOWFLAKE_DEMO.CORTEX_SENSE."RETAIL_SALES" TO ROLE INVOICE_APP_ROLE;

/* =====================================================================
   06 — GitHub Actions service user (OIDC / workload identity federation)
   ---------------------------------------------------------------------
   .github/workflows/deploy.yml runs its deploy job in the GitHub
   environment `prod`. This repo uses GitHub's immutable subject format
   (owner/repo IDs embedded), so the OIDC subject claim is exactly:
     repo:sfc-gh-jleong@204736462/app_runtime@1451879960:environment:prod
   Check the prefix with:
     gh api repos/sfc-gh-jleong/app_runtime/actions/oidc/customization/sub
   No password, key or token is stored anywhere.

   The account network policy (ACCOUNT_VPN_POLICY_SE) blocks GitHub-hosted
   runners. A user-level policy overrides it for this user only:
   GITHUB_ACTIONS_POLICY allows SNOWFLAKE.NETWORK_SECURITY.GITHUBACTIONS_GLOBAL
   (Snowflake-managed, auto-tracks GitHub runner IP ranges).
   ===================================================================== */
USE ROLE ACCOUNTADMIN;

CREATE USER IF NOT EXISTS GHA_INVOICE_APP_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = INVOICE_APP_ROLE
  DEFAULT_WAREHOUSE = COMPUTE_WH
  COMMENT = 'GitHub Actions deploys of the Invoice Reconciliation app (sfc-gh-jleong/app_runtime, environment prod) via OIDC'
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = 'https://token.actions.githubusercontent.com'
    SUBJECT = 'repo:sfc-gh-jleong@204736462/app_runtime@1451879960:environment:prod'
  );

-- Re-apply the subject if the user already existed (CREATE ... IF NOT EXISTS skips it).
ALTER USER GHA_INVOICE_APP_SVC SET WORKLOAD_IDENTITY = (
  TYPE = OIDC
  ISSUER = 'https://token.actions.githubusercontent.com'
  SUBJECT = 'repo:sfc-gh-jleong@204736462/app_runtime@1451879960:environment:prod'
);

GRANT ROLE INVOICE_APP_ROLE TO USER GHA_INVOICE_APP_SVC;
ALTER USER GHA_INVOICE_APP_SVC SET NETWORK_POLICY = GITHUB_ACTIONS_POLICY;

-- The account authentication policy UTIL_DB.PUBLIC.KEYPAIR_PAT_POLICY targets
-- SERVICE users and allows only KEYPAIR / PAT, which rejects OIDC logins. A
-- user-level policy overrides it for this user only. (The user has no password
-- or key, so workload identity is the only method it can actually use.)
ALTER USER GHA_INVOICE_APP_SVC SET AUTHENTICATION POLICY SNOWFLAKE_DEMO.PUBLIC.GITHUB_OIDC_AUTH_POLICY;

-- Verify
SHOW USER WORKLOAD IDENTITY AUTHENTICATION METHODS FOR USER GHA_INVOICE_APP_SVC;
SHOW PARAMETERS LIKE 'NETWORK_POLICY' FOR USER GHA_INVOICE_APP_SVC;

export type DingTalkWorkspaceStatus = {
  status: 'unavailable' | 'needs_auth' | 'starting' | 'pending' | 'authorized' | 'error';
  authorizationId?: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
  error?: 'failed' | 'expired' | 'start_timeout' | 'denied' | 'invalid_client' | 'org_cli_disabled' | 'permission_denied' | 'network_error' | 'owner_changed' | 'busy';
};

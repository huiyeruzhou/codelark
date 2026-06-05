export interface PermissionLinkInput {
  permissionRequestId: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  messageId: string;
  sessionId?: string;
  toolName: string;
  suggestions: string;
}

export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  sessionId?: string;
  resolved: boolean;
  suggestions: string;
}

export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  createdAt: string;
}

export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
}

export interface PermissionGateway {
  resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): boolean;
}

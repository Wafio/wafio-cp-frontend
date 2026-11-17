/**
 * Member management error messages. The server answers
 * 409 LAST_OWNER when a role change would leave the project without an
 * owner, and 404 USER_NOT_FOUND when a user to add does not exist.
 */

export interface MemberApiError {
  error?: string;
  code?: string;
  status?: number;
}

export const LAST_OWNER_MESSAGE =
  'The project must keep at least one owner. Make another member an owner first, then change this role.';

/** Message for a failed role change; `reload`: the member list is stale and should be reloaded. */
export function roleChangeError(err: MemberApiError | null | undefined): { message: string; reload: boolean } {
  if (err?.code === 'LAST_OWNER' || (err?.status === 409 && !err.code)) {
    return { message: LAST_OWNER_MESSAGE, reload: true };
  }
  if (err?.code === 'MEMBER_NOT_FOUND') {
    return { message: 'This user is no longer a member of the project. The list has been reloaded.', reload: true };
  }
  return { message: err?.error || 'The role could not be changed.', reload: false };
}

/** Message for a failed add-member call. */
export function addMemberError(err: MemberApiError | null | undefined): string {
  if (err?.code === 'USER_NOT_FOUND' || err?.status === 404) {
    return 'That user no longer exists, so it could not be added to the project.';
  }
  return err?.error || 'The member could not be added.';
}

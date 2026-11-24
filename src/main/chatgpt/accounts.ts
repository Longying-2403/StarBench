// Several ChatGPT accounts can be signed in at once, each as a provider of its own. What makes
// two of them the same is the registration, not the person: OpenAI gives a registration (its
// client id) to one person and one of their workspaces, so a person with a personal plan and a
// Team workspace under the same address has two, with the same subject and the same email
// ("Email and sub are not workspace identifiers; retain the issued client ID with the verified
// identity to keep registrations separate", developers.openai.com/siwc/token-sharing-open-source/sign-in).
// This says where a sign-in that has just ended goes, so that one registration is never listed twice.

/** A registration that a provider holds: signed in, or signed out of and still known. */
export interface HeldAccount {
  providerId: string
  /** The registration, as the service names it (`LoginRecord.clientId`): one person and one of their workspaces. */
  clientId: string
}

/**
 * Where a sign-in that has just ended is kept. `asked` is the provider it was started for, absent
 * for one that was to add an account; `clientId` is the registration that signed in.
 *
 * It goes where it was asked to go, and to a provider of its own where it was to add an account,
 * unless another provider holds that very registration already. Then it goes to that provider
 * (`moved`), which has the new sign-in from then on: the latest one is the one known to work.
 * Another workspace of the same person is another registration, and is kept apart.
 */
export function placeForSignIn(held: readonly HeldAccount[], asked: string | undefined, clientId: string): { providerId?: string; moved: boolean } {
  const other = held.find((account) => account.clientId === clientId && account.providerId !== asked)
  if (other) return { providerId: other.providerId, moved: true }
  return { ...(asked ? { providerId: asked } : {}), moved: false }
}

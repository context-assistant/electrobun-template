/**
 * Internal mount-path tokens used by the UI to represent dynamic container paths.
 *
 * These tokens are resolved by the backend before running `docker create`.
 */

/** Mount to the image/user-specific home directory (e.g. /root, /home/node, /var/lib/postgresql). */
export const CA_HOME_MOUNT_TOKEN = "__context_assistant_home__";


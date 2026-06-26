/*
 * list-groups.js — print every group you're in, with its JID, so you can paste
 * the ones you want into config.json -> watchedGroups.
 *
 *   npm run groups
 */
const { runSocket } = require('./socket');

runSocket({
  onOpen: async (sock) => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups).sort((a, b) =>
        (a.subject || '').localeCompare(b.subject || '')
      );
      console.log(`\n${list.length} groups (copy the JID on the left):\n`);
      for (const g of list) {
        console.log(`${g.id}\t${g.subject || '(no subject)'}`);
      }
      console.log('\nDone. Paste the JIDs you want into config.json -> watchedGroups.');
    } catch (e) {
      console.error('Failed to fetch groups:', e.message);
    } finally {
      process.exit(0);
    }
  },
}).catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

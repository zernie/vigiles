---
name: Status Footer
description: End the reply to each user message with one short status block.
---

## Status

- End the reply to each user message with a status block: what you are working on, what waits on the user, and what is done.
- One block per user message. A turn that a Stop hook forces belongs to the same message, so it gets no block of its own.
- Print the block as markdown, not inside a code block, so the bold shows.

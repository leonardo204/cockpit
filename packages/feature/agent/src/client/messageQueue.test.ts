import { describe, it, expect } from 'vitest';
import {
  EMPTY_MESSAGE_QUEUE,
  appendToDraft,
  clearRunOutcome,
  enqueueMessage,
  markErrored,
  markStopped,
  mergeQueued,
  removeQueued,
  settleRunEnd,
  takeQueued,
  type MessageQueueState,
} from './messageQueue';
import type { ImageInfo } from './types';

const img = (id: string): ImageInfo => ({ id, data: id, preview: `data:image/png;base64,${id}`, media_type: 'image/png' });

function queued(...entries: Array<[string, string, ImageInfo[]?]>): MessageQueueState {
  return entries.reduce(
    (s, [id, content, images]) => enqueueMessage(s, content, images, id),
    EMPTY_MESSAGE_QUEUE,
  );
}

describe('enqueueMessage', () => {
  it('appends in order and keeps images', () => {
    const s = queued(['a', 'first'], ['b', 'second', [img('x')]]);
    expect(s.items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.items[1].images?.map((i) => i.id)).toEqual(['x']);
    expect('images' in s.items[0]).toBe(false);
  });

  it('ignores an empty message', () => {
    expect(enqueueMessage(EMPTY_MESSAGE_QUEUE, '   ')).toBe(EMPTY_MESSAGE_QUEUE);
    expect(enqueueMessage(EMPTY_MESSAGE_QUEUE, '', [])).toBe(EMPTY_MESSAGE_QUEUE);
  });

  it('accepts an image-only message', () => {
    expect(enqueueMessage(EMPTY_MESSAGE_QUEUE, '', [img('x')], 'a').items).toHaveLength(1);
  });

  it('keeps slash commands verbatim', () => {
    expect(queued(['a', '/plan do it']).items[0].content).toBe('/plan do it');
  });

  it('generates distinct ids by default', () => {
    const s = enqueueMessage(enqueueMessage(EMPTY_MESSAGE_QUEUE, 'a'), 'b');
    expect(s.items[0].id).not.toBe(s.items[1].id);
  });
});

describe('mergeQueued', () => {
  it('joins bodies with a blank line and collects images in queue order', () => {
    const s = queued(['a', 'one', [img('1')]], ['b', 'two'], ['c', 'three', [img('2'), img('3')]]);
    expect(mergeQueued(s.items)).toEqual({ content: 'one\n\ntwo\n\nthree', images: [img('1'), img('2'), img('3')] });
  });

  it('skips empty bodies of image-only items', () => {
    const s = queued(['a', '', [img('1')]], ['b', 'text']);
    expect(mergeQueued(s.items)).toEqual({ content: 'text', images: [img('1')] });
  });

  it('omits images when there are none, and is null for an empty queue', () => {
    expect(mergeQueued(queued(['a', 'x']).items)).toEqual({ content: 'x' });
    expect(mergeQueued([])).toBeNull();
  });
});

describe('appendToDraft', () => {
  it('fills an empty composer', () => {
    expect(appendToDraft('', 'queued')).toBe('queued');
    expect(appendToDraft('  \n', 'queued')).toBe('queued');
  });

  it('keeps the existing draft first, then a blank line', () => {
    expect(appendToDraft('typing', 'queued')).toBe('typing\n\nqueued');
    expect(appendToDraft('typing\n', 'queued')).toBe('typing\n\nqueued');
  });

  it('leaves the draft alone when there is nothing to add', () => {
    expect(appendToDraft('typing', '')).toBe('typing');
  });
});

describe('removeQueued / takeQueued', () => {
  it('removes by id', () => {
    const s = removeQueued(queued(['a', '1'], ['b', '2']), 'a');
    expect(s.items.map((m) => m.id)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', () => {
    const s = queued(['a', '1']);
    expect(removeQueued(s, 'zz')).toBe(s);
    expect(takeQueued(s, 'zz')).toEqual({ state: s, item: null });
  });

  it('takes the item out for editing', () => {
    const { state, item } = takeQueued(queued(['a', '1'], ['b', '2', [img('x')]]), 'b');
    expect(item?.content).toBe('2');
    expect(item?.images?.[0].id).toBe('x');
    expect(state.items.map((m) => m.id)).toEqual(['a']);
  });
});

describe('settleRunEnd', () => {
  it('a normal end sends the merged queue once', () => {
    const first = settleRunEnd(queued(['a', 'one'], ['b', 'two']));
    expect(first.action).toEqual({ kind: 'send', content: 'one\n\ntwo' });
    expect(first.state.items).toHaveLength(0);
    // A second end signal (local stream end + run-idle) finds nothing.
    expect(settleRunEnd(first.state).action).toEqual({ kind: 'none' });
  });

  it('a stopped run restores instead of sending', () => {
    const { action, state } = settleRunEnd(markStopped(queued(['a', 'one'], ['b', 'two', [img('x')]])));
    expect(action).toEqual({ kind: 'restore', content: 'one\n\ntwo', images: [img('x')] });
    expect(state).toEqual(EMPTY_MESSAGE_QUEUE);
  });

  it('an errored run restores instead of sending', () => {
    expect(settleRunEnd(markErrored(queued(['a', 'one']))).action.kind).toBe('restore');
  });

  it('an empty queue does nothing but still clears the outcome', () => {
    const { action, state } = settleRunEnd(markErrored(EMPTY_MESSAGE_QUEUE));
    expect(action.kind).toBe('none');
    expect(state.errored).toBe(false);
    // So the NEXT run, which ends normally, sends.
    const next = settleRunEnd(enqueueMessage(state, 'later', undefined, 'a'));
    expect(next.action.kind).toBe('send');
  });

  it('a new send clears a stale outcome', () => {
    const s = clearRunOutcome(markStopped(markErrored(queued(['a', 'x']))));
    expect(s.stopped).toBe(false);
    expect(s.errored).toBe(false);
    expect(settleRunEnd(s).action.kind).toBe('send');
  });

  it('marking is idempotent', () => {
    const s = markStopped(EMPTY_MESSAGE_QUEUE);
    expect(markStopped(s)).toBe(s);
    expect(clearRunOutcome(EMPTY_MESSAGE_QUEUE)).toBe(EMPTY_MESSAGE_QUEUE);
  });
});

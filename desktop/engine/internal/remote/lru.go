package remote

import (
	"container/list"
	"sync"
)

// lru caches unwrapped keys by their wrapped (base64) form. Values are shared
// with callers, so they are dropped, never zeroed in place.
type lru struct {
	mu    sync.Mutex
	max   int
	order *list.List // front = most recent; values are *lruEntry
	items map[string]*list.Element
}

type lruEntry struct {
	key string
	val []byte
}

func newLRU(max int) *lru {
	return &lru{max: max, order: list.New(), items: map[string]*list.Element{}}
}

func (c *lru) get(k string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		c.order.MoveToFront(e)
		return e.Value.(*lruEntry).val, true
	}
	return nil, false
}

func (c *lru) put(k string, v []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		e.Value.(*lruEntry).val = v
		c.order.MoveToFront(e)
		return
	}
	c.items[k] = c.order.PushFront(&lruEntry{k, v})
	if c.order.Len() > c.max {
		delete(c.items, c.order.Remove(c.order.Back()).(*lruEntry).key)
	}
}

func (c *lru) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.order.Init()
	c.items = map[string]*list.Element{}
}

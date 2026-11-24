package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// The spool holds session lines that have not reached the user's Mac yet:
// <dataDir>/spool/<userId>/active.jsonl takes new lines; a sync pull seals it
// into <seq>.jsonl (seq from User.NextSegment), the app downloads sealed
// segments and acks them, and acked segments are deleted. Each spooled line
// is a record {"project","session","line"} where line is the raw JSONL line
// as sent, so the Mac writes back exactly the bytes the plugin produced.

type Segment struct {
	ID   int64 `json:"id"`
	Size int64 `json:"size"`
}

func (s *Server) spoolDir(uid string) string {
	return filepath.Join(s.cfg.DataDir, "spool", uid)
}

// spoolBytesFromDisk sums a user's spool files (startup; afterwards the
// count is kept in memory).
func (s *Server) spoolBytesFromDisk(uid string) int64 {
	var n int64
	entries, _ := os.ReadDir(s.spoolDir(uid))
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			n += info.Size()
		}
	}
	return n
}

func (s *Server) spoolAppend(uid string, data []byte) error {
	dir := s.spoolDir(uid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "active.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	// The spool is the only server-side copy until the Mac has it.
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// spoolSeal turns a non-empty active.jsonl into the next numbered segment.
// Call with the store lock held (it bumps u.NextSegment). Segment ids must
// only ever grow: the Mac skips ids it has already applied, so a reused id
// would be acked and deleted unread. So the new id is above every segment
// on disk, and is saved to state.json before the rename.
func (s *Server) spoolSeal(u *User) error {
	active := filepath.Join(s.spoolDir(u.ID), "active.jsonl")
	info, err := os.Stat(active)
	if err != nil || info.Size() == 0 {
		return nil
	}
	next := u.NextSegment + 1
	for _, seg := range s.spoolSegments(u.ID) {
		if seg.ID >= next {
			next = seg.ID + 1
		}
	}
	prev := u.NextSegment
	u.NextSegment = next
	if err := s.store.saveLocked(); err != nil {
		u.NextSegment = prev
		return err
	}
	return os.Rename(active, s.segmentPath(u.ID, next))
}

func (s *Server) segmentPath(uid string, id int64) string {
	return filepath.Join(s.spoolDir(uid), fmt.Sprintf("%012d.jsonl", id))
}

// spoolSegments lists sealed segments, oldest first.
func (s *Server) spoolSegments(uid string) []Segment {
	out := []Segment{}
	entries, _ := os.ReadDir(s.spoolDir(uid))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || name == "active.jsonl" || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimSuffix(name, ".jsonl"), 10, 64)
		if err != nil {
			continue
		}
		if info, err := e.Info(); err == nil {
			out = append(out, Segment{ID: id, Size: info.Size()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// waitChan answers a channel closed on the user's next ingest (long-poll).
// Call with the store lock held.
func (s *Server) waitChan(uid string) chan struct{} {
	ch := s.waiters[uid]
	if ch == nil {
		ch = make(chan struct{})
		s.waiters[uid] = ch
	}
	return ch
}

// notify wakes the user's long-polling syncs. Call with the store lock held.
func (s *Server) notify(uid string) {
	if ch := s.waiters[uid]; ch != nil {
		close(ch)
		delete(s.waiters, uid)
	}
}

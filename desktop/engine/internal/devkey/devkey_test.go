package devkey

import "testing"

func TestSoftwareKeyRoundTrip(t *testing.T) {
	k, err := newSoftware()
	if err != nil {
		t.Fatal(err)
	}
	if err := selfCheck(k); err != nil {
		t.Fatal(err)
	}
	again, err := Load(k.Ref())
	if err != nil {
		t.Fatal(err)
	}
	if string(again.PublicDER()) != string(k.PublicDER()) || selfCheck(again) != nil {
		t.Fatal("reloaded key differs")
	}
	if _, err := Load("bogus"); err == nil {
		t.Fatal("bogus ref loaded")
	}
}

package visualization

import "testing"

func TestValidateAcceptsVersionedDataAndRejectsExecutableFields(t *testing.T) {
	if err := Validate([]byte(`{"version":1,"type":"metric","title":"成功率","value":98}`)); err != nil {
		t.Fatal(err)
	}
	if err := Validate([]byte(`{"version":1,"type":"metric","title":"x","script":"alert(1)"}`)); err == nil {
		t.Fatal("script accepted")
	}
	if err := Validate([]byte(`{"version":1,"type":"table","title":"x","data":{"rows":[{"onClick":"run"}]}}`)); err == nil {
		t.Fatal("nested executable field accepted")
	}
	if err := Validate([]byte(`{"version":2,"type":"metric","title":"x"}`)); err == nil {
		t.Fatal("version accepted")
	}
}

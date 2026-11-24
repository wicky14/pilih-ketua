GO ?= go
BINARY ?= bin/pilih-ketua

.PHONY: build run test clean

build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o $(BINARY) .

run: build
	./$(BINARY)

test:
	$(GO) test ./...

clean:
	rm -rf bin

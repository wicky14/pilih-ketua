package main

import (
	"context"
	"embed"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata"
)

//go:embed all:public
var publicFS embed.FS

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = 200
	}
	return r.ResponseWriter.Write(data)
}

func loggingHandler(s *server) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w}
		started := time.Now()
		s.ServeHTTP(recorder, r)
		log.Printf("%s %s %d %dms", r.Method, r.URL.RequestURI(), recorder.status, time.Since(started).Milliseconds())
	})
}

func main() {
	cfg := loadConfig()
	secret := loadSecret(cfg.DataDir)
	store, err := openStore(cfg, secret)
	if err != nil {
		log.Fatalf("[init] database: %v", err)
	}
	startRateCleanup()

	election, err := store.getElection()
	if err != nil {
		log.Fatalf("[init] election: %v", err)
	}

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           loggingHandler(&server{store: store}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		log.Println("Menutup server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		_ = store.db.Close()
		close(shutdownDone)
	}()

	log.Printf("Pilih Ketua siap di http://localhost:%d", cfg.Port)
	log.Printf("Link voting: http://localhost:%d/vote/%s", cfg.Port, election.Slug)
	log.Printf("Admin: http://localhost:%d/admin", cfg.Port)
	log.Printf("Layar publik: http://localhost:%d/display", cfg.Port)

	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[server] %v", err)
	}
	<-shutdownDone
}

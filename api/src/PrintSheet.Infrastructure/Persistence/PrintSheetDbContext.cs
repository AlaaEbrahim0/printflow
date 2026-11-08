using Microsoft.EntityFrameworkCore;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Jobs;

namespace PrintSheet.Infrastructure.Persistence;

/// <summary>
/// EF Core mapping for the whole MVP. The batch aggregate is loaded as one
/// graph; jobs and settings are independent tables. Enum values are stored as
/// their contract strings so the data stays readable and greppable.
/// </summary>
public sealed class PrintSheetDbContext(DbContextOptions<PrintSheetDbContext> options)
    : DbContext(options)
{
    public DbSet<Batch> Batches => Set<Batch>();

    public DbSet<Job> Jobs => Set<Job>();

    public DbSet<AppSettingsRecord> AppSettings => Set<AppSettingsRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ConfigureBatch(modelBuilder);
        ConfigureJob(modelBuilder);
        ConfigureSettings(modelBuilder);
    }

    private static void ConfigureBatch(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Batch>(batch =>
        {
            batch.ToTable("batches");
            batch.HasKey(entity => entity.Id);
            batch.Property(entity => entity.Id).ValueGeneratedNever();
            batch.Property(entity => entity.Id).HasColumnName("id");
            batch.Property(entity => entity.Name)
                .HasColumnName("name")
                .HasMaxLength(Batch.MaxNameLength)
                .IsRequired();
            batch.Property(entity => entity.Status)
                .HasColumnName("status")
                .HasConversion(EnumText.BatchStatusConverter)
                .HasMaxLength(32)
                .IsRequired();
            batch.Property(entity => entity.RowVersion)
                .HasColumnName("row_version")
                .IsConcurrencyToken();
            batch.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            batch.Property(entity => entity.UpdatedAt).HasColumnName("updated_at");

            batch.OwnsOne(entity => entity.Geometry, geometry =>
            {
                geometry.Property(value => value.RollWidthCm)
                    .HasColumnName("roll_width_cm")
                    .HasPrecision(9, 3);
                geometry.Property(value => value.MarginMm)
                    .HasColumnName("margin_mm")
                    .HasPrecision(9, 3);
                geometry.Property(value => value.EdgeMarginMm)
                    .HasColumnName("edge_margin_mm")
                    .HasPrecision(9, 3);
                geometry.Property(value => value.WorkingDpi).HasColumnName("working_dpi");
                geometry.Ignore(value => value.UsableWidthCm);
                geometry.Ignore(value => value.RollWidthPx);
                geometry.Ignore(value => value.MarginPx);
            });

            batch.Ignore(entity => entity.CurrentSheet);
            batch.Ignore(entity => entity.CurrentRevision);
            batch.Ignore(entity => entity.DesignCount);
            batch.Ignore(entity => entity.ReadyCount);
            batch.Ignore(entity => entity.ExcludedCount);
            batch.Ignore(entity => entity.IncludedDesigns);

            batch.HasMany(entity => entity.Designs)
                .WithOne()
                .HasForeignKey(design => design.BatchId)
                .OnDelete(DeleteBehavior.Cascade);
            batch.Navigation(entity => entity.Designs)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            batch.HasMany(entity => entity.Sheets)
                .WithOne()
                .HasForeignKey(sheet => sheet.BatchId)
                .OnDelete(DeleteBehavior.Cascade);
            batch.Navigation(entity => entity.Sheets)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            batch.HasMany(entity => entity.Exports)
                .WithOne()
                .HasForeignKey(export => export.BatchId)
                .OnDelete(DeleteBehavior.Cascade);
            batch.Navigation(entity => entity.Exports)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            batch.HasMany(entity => entity.AuditEntries)
                .WithOne()
                .HasForeignKey(entry => entry.BatchId)
                .OnDelete(DeleteBehavior.Cascade);
            batch.Navigation(entity => entity.AuditEntries)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            batch.HasIndex(entity => entity.Status);
            batch.HasIndex(entity => entity.UpdatedAt);
        });

        modelBuilder.Entity<Design>(design =>
        {
            design.ToTable("designs");
            design.HasKey(entity => entity.Id);
            design.Property(entity => entity.Id).ValueGeneratedNever();
            design.Property(entity => entity.Id).HasColumnName("id");
            design.Property(entity => entity.BatchId).HasColumnName("batch_id");
            design.Property(entity => entity.Name)
                .HasColumnName("name")
                .HasMaxLength(200)
                .IsRequired();
            design.Property(entity => entity.Status)
                .HasColumnName("status")
                .HasConversion(EnumText.DesignStatusConverter)
                .HasMaxLength(32)
                .IsRequired();
            design.Property(entity => entity.AllowRotation).HasColumnName("allow_rotation");
            design.Property(entity => entity.TargetWidthCm)
                .HasColumnName("target_width_cm")
                .HasPrecision(9, 3);
            design.Property(entity => entity.TargetHeightCm)
                .HasColumnName("target_height_cm")
                .HasPrecision(9, 3);
            design.Property(entity => entity.OriginalVersionId).HasColumnName("original_version_id");
            design.Property(entity => entity.CurrentVersionId).HasColumnName("current_version_id");
            design.Property(entity => entity.PendingVersionId).HasColumnName("pending_version_id");
            design.Property(entity => entity.BetterSourceRequested).HasColumnName("better_source_requested");
            design.Property(entity => entity.Notes).HasColumnName("notes").HasMaxLength(2000);
            design.Property(entity => entity.WorkingDpi).HasColumnName("working_dpi");
            design.Property(entity => entity.SuggestionsJson).HasColumnName("suggestions_json");
            design.Property(entity => entity.SuggestionsStatus)
                .HasColumnName("suggestions_status")
                .HasMaxLength(16);
            design.Property(entity => entity.SuggestionsAnalyzedAt).HasColumnName("suggestions_analyzed_at");
            design.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            design.Property(entity => entity.UpdatedAt).HasColumnName("updated_at");

            design.OwnsOne(entity => entity.GarmentColor, garment =>
            {
                garment.Property(value => value.Kind)
                    .HasColumnName("garment_color_kind")
                    .HasConversion(EnumText.GarmentColorKindConverter)
                    .HasMaxLength(16)
                    .IsRequired();
                garment.Property(value => value.Hex)
                    .HasColumnName("garment_color_hex")
                    .HasMaxLength(7);
            });

            design.Ignore(entity => entity.CurrentVersion);
            design.Ignore(entity => entity.PendingVersion);
            design.Ignore(entity => entity.IsReady);
            design.Ignore(entity => entity.EffectiveDpi);
            design.Ignore(entity => entity.VersionCount);

            design.HasMany(entity => entity.Versions)
                .WithOne()
                .HasForeignKey(version => version.DesignId)
                .OnDelete(DeleteBehavior.Cascade);
            design.Navigation(entity => entity.Versions)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            design.HasIndex(entity => entity.BatchId);
            design.HasIndex(entity => entity.Status);
        });

        modelBuilder.Entity<DesignVersion>(version =>
        {
            version.ToTable("design_versions");
            version.HasKey(entity => entity.Id);
            version.Property(entity => entity.Id).ValueGeneratedNever();
            version.Property(entity => entity.Id).HasColumnName("id");
            version.Property(entity => entity.DesignId).HasColumnName("design_id");
            version.Property(entity => entity.ParentId).HasColumnName("parent_id");
            version.Property(entity => entity.StepType)
                .HasColumnName("step_type")
                .HasConversion(EnumText.StepTypeConverter)
                .HasMaxLength(32)
                .IsRequired();
            version.Property(entity => entity.Status)
                .HasColumnName("status")
                .HasConversion(EnumText.VersionStatusConverter)
                .HasMaxLength(16)
                .IsRequired();
            version.Property(entity => entity.FilePath).HasColumnName("file_path").IsRequired();
            version.Property(entity => entity.MaskPath).HasColumnName("mask_path");
            version.Property(entity => entity.SvgPath).HasColumnName("svg_path");
            version.Property(entity => entity.WidthPx).HasColumnName("width_px");
            version.Property(entity => entity.HeightPx).HasColumnName("height_px");
            version.Property(entity => entity.HasAlpha).HasColumnName("has_alpha");
            version.Property(entity => entity.ParametersJson).HasColumnName("parameters_json").IsRequired();
            version.Property(entity => entity.JobId).HasColumnName("job_id");
            version.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            version.Property(entity => entity.ApprovedAt).HasColumnName("approved_at");
            version.Property(entity => entity.RejectedAt).HasColumnName("rejected_at");
            version.Property(entity => entity.RejectionReason).HasColumnName("rejection_reason").HasMaxLength(2000);
            version.HasIndex(entity => entity.DesignId);
        });

        modelBuilder.Entity<Sheet>(sheet =>
        {
            sheet.ToTable("sheets");
            sheet.HasKey(entity => entity.Id);
            sheet.Property(entity => entity.Id).ValueGeneratedNever();
            sheet.Property(entity => entity.Id).HasColumnName("id");
            sheet.Property(entity => entity.BatchId).HasColumnName("batch_id");
            sheet.Property(entity => entity.Revision).HasColumnName("revision");
            sheet.Property(entity => entity.State)
                .HasColumnName("state")
                .HasConversion(EnumText.SheetStateConverter)
                .HasMaxLength(16)
                .IsRequired();
            sheet.Property(entity => entity.Stale).HasColumnName("stale");
            sheet.Property(entity => entity.WidthCm)
                .HasColumnName("width_cm")
                .HasPrecision(9, 3);
            sheet.Property(entity => entity.HeightCm)
                .HasColumnName("height_cm")
                .HasPrecision(9, 3);
            sheet.Property(entity => entity.WidthPx).HasColumnName("width_px");
            sheet.Property(entity => entity.HeightPx).HasColumnName("height_px");
            sheet.Property(entity => entity.Dpi).HasColumnName("dpi");
            sheet.Property(entity => entity.IntegrityReportJson).HasColumnName("integrity_report_json");
            sheet.Property(entity => entity.PreviewPath).HasColumnName("preview_path").IsRequired();
            sheet.Property(entity => entity.ManifestPath).HasColumnName("manifest_path").IsRequired();
            sheet.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            sheet.Property(entity => entity.UpdatedAt).HasColumnName("updated_at");

            sheet.OwnsOne(entity => entity.EstimatedCost, cost =>
            {
                cost.Property(value => value.Amount)
                    .HasColumnName("estimated_cost_amount")
                    .HasPrecision(12, 2);
                cost.Property(value => value.Currency)
                    .HasColumnName("estimated_cost_currency")
                    .HasMaxLength(3);
            });

            sheet.Ignore(entity => entity.IntegrityPassed);

            sheet.OwnsMany(entity => entity.Placements, placement =>
            {
                placement.ToTable("sheet_placements");
                placement.WithOwner().HasForeignKey("sheet_id");
                placement.Property<Guid>("id").ValueGeneratedOnAdd();
                placement.HasKey("id");
                placement.Property(value => value.DesignId).HasColumnName("design_id");
                placement.Property(value => value.VersionId).HasColumnName("version_id");
                placement.Property(value => value.DesignName).HasColumnName("design_name").HasMaxLength(200);
                placement.Property(value => value.XCm).HasColumnName("x_cm").HasPrecision(9, 3);
                placement.Property(value => value.YCm).HasColumnName("y_cm").HasPrecision(9, 3);
                placement.Property(value => value.WidthCm).HasColumnName("width_cm").HasPrecision(9, 3);
                placement.Property(value => value.HeightCm).HasColumnName("height_cm").HasPrecision(9, 3);
                placement.Property(value => value.WidthPx).HasColumnName("width_px");
                placement.Property(value => value.HeightPx).HasColumnName("height_px");
                placement.Property(value => value.RotationDeg).HasColumnName("rotation_deg");
                placement.Ignore(value => value.AllowRotation);
            });
            sheet.Navigation(entity => entity.Placements)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            sheet.HasIndex(entity => new { entity.BatchId, entity.Revision }).IsUnique();
        });

        modelBuilder.Entity<ExportRecord>(export =>
        {
            export.ToTable("exports");
            export.HasKey(entity => entity.Id);
            export.Property(entity => entity.Id).ValueGeneratedNever();
            export.Property(entity => entity.Id).HasColumnName("id");
            export.Property(entity => entity.BatchId).HasColumnName("batch_id");
            export.Property(entity => entity.SheetId).HasColumnName("sheet_id");
            export.Property(entity => entity.SheetRevision).HasColumnName("sheet_revision");
            export.Property(entity => entity.Format)
                .HasColumnName("format")
                .HasConversion(EnumText.ExportFormatConverter)
                .HasMaxLength(32)
                .IsRequired();
            export.Property(entity => entity.Status)
                .HasColumnName("status")
                .HasConversion(EnumText.ExportStatusConverter)
                .HasMaxLength(16)
                .IsRequired();
            export.Property(entity => entity.Dpi).HasColumnName("dpi");
            export.Property(entity => entity.IntegrityReportJson).HasColumnName("integrity_report_json");
            export.Property(entity => entity.BlockedReason).HasColumnName("blocked_reason");
            export.Property(entity => entity.ErrorJson).HasColumnName("error_json");
            export.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            export.Property(entity => entity.CompletedAt).HasColumnName("completed_at");

            export.OwnsMany(entity => entity.Artifacts, artifact =>
            {
                artifact.ToTable("export_artifacts");
                artifact.WithOwner().HasForeignKey("export_id");
                artifact.Property<Guid>("id").ValueGeneratedOnAdd();
                artifact.HasKey("id");
                artifact.Property(value => value.Name)
                    .HasColumnName("name")
                    .HasConversion(EnumText.ExportArtifactNameConverter)
                    .HasMaxLength(16)
                    .IsRequired();
                artifact.Property(value => value.ContentType).HasColumnName("content_type").IsRequired();
                artifact.Property(value => value.SizeBytes).HasColumnName("size_bytes");
                artifact.Property(value => value.StoragePath).HasColumnName("storage_path").IsRequired();
            });
            export.Navigation(entity => entity.Artifacts)
                .UsePropertyAccessMode(PropertyAccessMode.Field);

            export.HasIndex(entity => entity.BatchId);
        });

        modelBuilder.Entity<AuditEntry>(entry =>
        {
            entry.ToTable("audit_entries");
            entry.HasKey(entity => entity.Id);
            entry.Property(entity => entity.Id).ValueGeneratedNever();
            entry.Property(entity => entity.Id).HasColumnName("id");
            entry.Property(entity => entity.BatchId).HasColumnName("batch_id");
            entry.Property(entity => entity.DesignId).HasColumnName("design_id");
            entry.Property(entity => entity.VersionId).HasColumnName("version_id");
            entry.Property(entity => entity.Action).HasColumnName("action").HasMaxLength(100).IsRequired();
            entry.Property(entity => entity.Actor).HasColumnName("actor").HasMaxLength(100).IsRequired();
            entry.Property(entity => entity.Reason).HasColumnName("reason").HasMaxLength(2000);
            entry.Property(entity => entity.DetailsJson).HasColumnName("details_json");
            entry.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            entry.HasIndex(entity => entity.BatchId);
        });
    }

    private static void ConfigureJob(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Job>(job =>
        {
            job.ToTable("jobs");
            job.HasKey(entity => entity.Id);
            job.Property(entity => entity.Id).ValueGeneratedNever();
            job.Property(entity => entity.Id).HasColumnName("id");
            job.Property(entity => entity.BatchId).HasColumnName("batch_id");
            job.Property(entity => entity.DesignId).HasColumnName("design_id");
            job.Property(entity => entity.Type)
                .HasColumnName("type")
                .HasConversion(EnumText.JobTypeConverter)
                .HasMaxLength(32)
                .IsRequired();
            job.Property(entity => entity.Capability)
                .HasColumnName("capability")
                .HasConversion(EnumText.JobCapabilityConverter)
                .HasMaxLength(16)
                .IsRequired();
            job.Property(entity => entity.Status)
                .HasColumnName("status")
                .HasConversion(EnumText.JobStatusConverter)
                .HasMaxLength(16)
                .IsRequired();
            job.Property(entity => entity.ParametersJson).HasColumnName("parameters_json").IsRequired();
            job.Property(entity => entity.ContextJson).HasColumnName("context_json").IsRequired();
            job.Property(entity => entity.InputPath).HasColumnName("input_path");
            job.Property(entity => entity.OutputPath).HasColumnName("output_path");
            job.Property(entity => entity.InputArtifactsJson).HasColumnName("input_artifacts_json").IsRequired();
            job.Property(entity => entity.OutputArtifactsJson).HasColumnName("output_artifacts_json").IsRequired();
            job.Property(entity => entity.Attempts).HasColumnName("attempts");
            job.Property(entity => entity.MaxAttempts).HasColumnName("max_attempts");
            job.Property(entity => entity.LeaseOwner).HasColumnName("lease_owner").HasMaxLength(200);
            job.Property(entity => entity.LeaseToken).HasColumnName("lease_token").HasMaxLength(100);
            job.Property(entity => entity.LeaseExpiresAt).HasColumnName("lease_expires_at");
            job.Property(entity => entity.ResultJson).HasColumnName("result_json");
            job.Property(entity => entity.ErrorJson).HasColumnName("error_json");
            job.Property(entity => entity.CreatedAt).HasColumnName("created_at");
            job.Property(entity => entity.UpdatedAt).HasColumnName("updated_at");
            job.Property(entity => entity.StartedAt).HasColumnName("started_at");
            job.Property(entity => entity.CompletedAt).HasColumnName("completed_at");
            job.Property(entity => entity.DurationMs).HasColumnName("duration_ms");

            job.Ignore(entity => entity.IsWorkerJob);

            job.HasIndex(entity => new { entity.Status, entity.Capability, entity.CreatedAt });
            job.HasIndex(entity => new { entity.BatchId, entity.Status });
            job.HasIndex(entity => entity.LeaseExpiresAt);
            job.HasIndex(entity => entity.DesignId);
        });
    }

    private static void ConfigureSettings(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AppSettingsRecord>(settings =>
        {
            settings.ToTable("app_settings");
            settings.HasKey(entity => entity.Id);
            settings.Property(entity => entity.Id).ValueGeneratedNever();
            settings.Property(entity => entity.Id).HasColumnName("id").HasMaxLength(32);
            settings.Property(entity => entity.Json).HasColumnName("json").IsRequired();
            settings.Property(entity => entity.UpdatedAt).HasColumnName("updated_at");
        });
    }
}

/// <summary>Singleton row holding the serialised <see cref="Application.Settings.AppSettings"/>.</summary>
public sealed class AppSettingsRecord
{
    public string Id { get; set; } = "default";

    public string Json { get; set; } = "{}";

    public DateTimeOffset UpdatedAt { get; set; }
}

# On-Call Incident Escalation Guide

## Purpose

This guide describes how the on-call engineer handles a production incident from the first alert to closure.

## Trigger

Start this procedure when a monitoring alert with severity "critical" fires, or when a customer reports a full outage.

## Steps

1. The on-call engineer acknowledges the alert within 5 minutes.
2. The engineer opens an incident ticket and records the start time.
3. The engineer posts a status update in the incident channel every 30 minutes until resolved.

## Who decides

The on-call engineer may roll back the latest release without approval.
Any database restore must be approved by the Engineering Manager.

## Closure

An incident is closed when the service has been healthy for 60 minutes. A written post-incident review is due within 5 business days.

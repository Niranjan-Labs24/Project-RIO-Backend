/*
  Warnings:

  - Added the required column `title` to the `needs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "needs" ADD COLUMN     "title" VARCHAR(300) NOT NULL;
